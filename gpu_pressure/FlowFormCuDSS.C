// SPDX-License-Identifier: GPL-3.0-or-later
// OpenFOAM Foundation v14 adapter for NVIDIA's cuDSS pressure solve.
#include "lduMatrix.H"
#include "lduInterfaceField.H"
#include "Pstream.H"

#include <cuda_runtime_api.h>
#include <cudss.h>
#include <algorithm>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace
{
void check(cudaError_t status, const char* operation)
{
    if (status != cudaSuccess)
    {
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
    }
}

void check(cudssStatus_t status, const char* operation)
{
    if (status != CUDSS_STATUS_SUCCESS)
    {
        throw std::runtime_error(std::string(operation) + ": cuDSS status " + std::to_string(status));
    }
}

template<class T>
class DeviceBuffer
{
    T* data_ = nullptr;

public:
    explicit DeviceBuffer(std::size_t count)
    {
        check(cudaMalloc(reinterpret_cast<void**>(&data_), count * sizeof(T)), "cudaMalloc");
    }

    ~DeviceBuffer() { cudaFree(data_); }
    DeviceBuffer(const DeviceBuffer&) = delete;
    DeviceBuffer& operator=(const DeviceBuffer&) = delete;

    T* data() const { return data_; }

    void upload(const T* source, std::size_t count)
    {
        check(cudaMemcpy(data_, source, count * sizeof(T), cudaMemcpyHostToDevice), "upload");
    }
};

struct DirectSolver
{
    cudssHandle_t handle = nullptr;
    cudssConfig_t config = nullptr;
    cudssData_t data = nullptr;
    cudssMatrix_t a = nullptr;
    cudssMatrix_t x = nullptr;
    cudssMatrix_t b = nullptr;

    ~DirectSolver()
    {
        if (b) cudssMatrixDestroy(b);
        if (x) cudssMatrixDestroy(x);
        if (a) cudssMatrixDestroy(a);
        if (data) cudssDataDestroy(handle, data);
        if (config) cudssConfigDestroy(config);
        if (handle) cudssDestroy(handle);
    }
};

struct CsrLayout
{
    const int cells;
    std::vector<int> owner, neighbour;
    std::vector<int> offsets, columns;
    std::vector<int> diagonalSlot, lowerSlot, upperSlot;

    explicit CsrLayout(const Foam::lduMatrix& matrix)
    :
        cells(matrix.diag().size()),
        owner(matrix.lduAddr().lowerAddr().begin(), matrix.lduAddr().lowerAddr().end()),
        neighbour(matrix.lduAddr().upperAddr().begin(), matrix.lduAddr().upperAddr().end()),
        offsets(cells + 1, 0),
        columns(cells + 2 * owner.size()),
        diagonalSlot(cells),
        lowerSlot(owner.size()),
        upperSlot(owner.size())
    {
        std::fill(offsets.begin() + 1, offsets.end(), 1);
        for (std::size_t face = 0; face < owner.size(); ++face)
        {
            ++offsets[owner[face] + 1];
            ++offsets[neighbour[face] + 1];
        }
        for (int i = 0; i < cells; ++i) offsets[i + 1] += offsets[i];

        // Insert lower columns, diagonal, then upper columns in each CSR row.
        std::vector<int> cursor(offsets);
        for (std::size_t face = 0; face < owner.size(); ++face)
        {
            lowerSlot[face] = cursor[neighbour[face]]++;
            columns[lowerSlot[face]] = owner[face];
        }
        for (int i = 0; i < cells; ++i)
        {
            diagonalSlot[i] = cursor[i]++;
            columns[diagonalSlot[i]] = i;
        }
        for (std::size_t face = 0; face < owner.size(); ++face)
        {
            upperSlot[face] = cursor[owner[face]]++;
            columns[upperSlot[face]] = neighbour[face];
        }
    }

    bool matches(const Foam::lduMatrix& matrix) const
    {
        const auto& address = matrix.lduAddr();
        return matrix.diag().size() == cells
            && std::equal(owner.begin(), owner.end(), address.lowerAddr().begin(), address.lowerAddr().end())
            && std::equal(neighbour.begin(), neighbour.end(), address.upperAddr().begin(), address.upperAddr().end());
    }
};


class PressureSystem
{
    const CsrLayout layout_;
    std::vector<double> coefficients_;
    DeviceBuffer<int> offsets_, columns_;
    DeviceBuffer<double> values_, source_, solution_;
    DirectSolver solver_;
    bool factorized_ = false;

    void execute(cudssPhase_t phase, const char* operation)
    {
        check(cudssExecute(solver_.handle, phase, solver_.config, solver_.data,
            solver_.a, solver_.x, solver_.b), operation);
    }

    bool updateCoefficients(const Foam::lduMatrix& matrix)
    {
        bool changed = !factorized_;
        auto update = [&](int slot, double value)
        {
            changed |= coefficients_[slot] != value;
            coefficients_[slot] = value;
        };
        const auto& diag = matrix.diag();
        const auto& lower = matrix.lower();
        const auto& upper = matrix.upper();
        for (int i = 0; i < layout_.cells; ++i) update(layout_.diagonalSlot[i], diag[i]);
        for (std::size_t face = 0; face < layout_.owner.size(); ++face)
        {
            update(layout_.lowerSlot[face], lower[face]);
            update(layout_.upperSlot[face], upper[face]);
        }
        return changed;
    }

public:
    explicit PressureSystem(const Foam::lduMatrix& matrix)
    :
        layout_(matrix),
        coefficients_(layout_.columns.size()),
        offsets_(layout_.offsets.size()),
        columns_(layout_.columns.size()),
        values_(coefficients_.size()),
        source_(layout_.cells),
        solution_(layout_.cells)
    {
        const int n = layout_.cells;
        offsets_.upload(layout_.offsets.data(), layout_.offsets.size());
        columns_.upload(layout_.columns.data(), layout_.columns.size());

        check(cudssCreate(&solver_.handle), "cudssCreate");
        check(cudssConfigCreate(&solver_.config), "cudssConfigCreate");
        check(cudssDataCreate(solver_.handle, &solver_.data), "cudssDataCreate");
        check(cudssMatrixCreateCsr(&solver_.a, n, n, coefficients_.size(),
            offsets_.data(), nullptr, columns_.data(), values_.data(),
            CUDA_R_32I, CUDA_R_64F, CUDSS_MTYPE_GENERAL, CUDSS_MVIEW_FULL,
            CUDSS_BASE_ZERO), "create pressure matrix");
        check(cudssMatrixCreateDn(&solver_.x, n, 1, n, solution_.data(),
            CUDA_R_64F, CUDSS_LAYOUT_COL_MAJOR), "create solution");
        check(cudssMatrixCreateDn(&solver_.b, n, 1, n, source_.data(),
            CUDA_R_64F, CUDSS_LAYOUT_COL_MAJOR), "create source");
    }

    bool matches(const Foam::lduMatrix& matrix) const { return layout_.matches(matrix); }

    bool solve(const Foam::lduMatrix& matrix, const Foam::scalarField& source, Foam::scalarField& solution)
    {
        const bool refactor = updateCoefficients(matrix);
        if (refactor)
        {
            values_.upload(coefficients_.data(), coefficients_.size());
            if (!factorized_) execute(CUDSS_PHASE_ANALYSIS, "analyze pressure matrix");
            execute(CUDSS_PHASE_FACTORIZATION, "factor pressure matrix");
        }
        source_.upload(source.cdata(), source.size());
        execute(CUDSS_PHASE_SOLVE, "solve pressure matrix");
        check(cudaMemcpy(solution.data(), solution_.data(),
            solution.size() * sizeof(double), cudaMemcpyDeviceToHost), "download solution");

        int info = 0;
        check(cudssDataGet(solver_.handle, solver_.data, CUDSS_DATA_INFO,
            &info, sizeof(info), nullptr), "check pressure matrix");
        if (info != 0) throw std::runtime_error("cuDSS factorization info " + std::to_string(info));
        factorized_ = true;
        return refactor;
    }
};


struct PressureCache
{
    std::unique_ptr<PressureSystem> system;
    unsigned analyses = 0;
    unsigned factorizations = 0;
    unsigned solves = 0;

    ~PressureCache()
    {
        if (solves)
        {
            std::clog << "FlowForm CUDA pressure cache: solves=" << solves
                << ", analyses=" << analyses << ", factorizations=" << factorizations
                << ", reused=" << solves - factorizations << std::endl;
        }
    }
};

int cudaDevice()
{
    int device = 0;
    check(cudaGetDevice(&device), "cudaGetDevice");
    return device;
}

void solveOnGpu
(
    const Foam::lduMatrix& matrix,
    const Foam::scalarField& source,
    Foam::scalarField& solution
)
{
    static_assert(std::is_same<Foam::label, int>::value, "32-bit OpenFOAM labels required");
    static_assert(std::is_same<Foam::scalar, double>::value, "Double precision OpenFOAM required");

    // Initialize CUDA before constructing the static cache so the cache releases
    // its library handles before the runtime is torn down.
    static const int device = cudaDevice();
    static PressureCache cache;
    if (!cache.system || !cache.system->matches(matrix))
    {
        cache.system.reset();
        cache.system = std::make_unique<PressureSystem>(matrix);
        ++cache.analyses;
    }
    if (cache.system->solve(matrix, source, solution)) ++cache.factorizations;
    if (++cache.solves == 1)
    {
        cudaDeviceProp props{};
        check(cudaGetDeviceProperties(&props, device), "cudaGetDeviceProperties");
        Foam::Info << "FlowForm CUDA pressure solved on " << props.name << Foam::endl;
    }
}
}

namespace Foam
{
class FlowFormCuDSS : public lduMatrix::solver
{
public:
    TypeName("FlowFormCuDSS");
    using lduMatrix::solver::solver;

    solverPerformance solve(scalarField& psi, const scalarField& source, direction cmpt) const override
    {
        if (Pstream::parRun())
        {
            FatalErrorInFunction << "FlowFormCuDSS requires a single MPI-free case." << exit(FatalError);
        }
        forAll(interfaces_, patch)
        {
            if (interfaces_.set(patch))
            {
                FatalErrorInFunction << "FlowFormCuDSS does not support coupled interfaces." << exit(FatalError);
            }
        }
        scalarField product(source.size()), scratch(source.size());
        matrix_.Amul(product, psi, interfaceBouCoeffs_, interfaces_, cmpt);
        const scalar norm = this->normFactor(psi, source, product, scratch);
        solverPerformance performance(typeName, fieldName_);
        performance.initialResidual() = sumMag(source - product) / norm;
        performance.finalResidual() = performance.initialResidual();
        if (minIter_ == 0 && performance.checkConvergence(tolerance_, relTol_)) return performance;

        try
        {
            solveOnGpu(matrix_, source, psi);
        }
        catch (const std::exception& error)
        {
            FatalErrorInFunction << error.what() << exit(FatalError);
        }

        matrix_.Amul(product, psi, interfaceBouCoeffs_, interfaces_, cmpt);
        performance.finalResidual() = sumMag(source - product) / norm;
        performance.nIterations() = 1;
        if (!std::isfinite(performance.finalResidual()) || !performance.checkConvergence(tolerance_, relTol_))
        {
            FatalErrorInFunction << "GPU pressure residual " << performance.finalResidual()
                << " failed convergence for " << fieldName_ << exit(FatalError);
        }
        return performance;
    }
};

defineTypeNameAndDebug(FlowFormCuDSS, 0);
lduMatrix::solver::addsymMatrixConstructorToTable<FlowFormCuDSS> addCuDSSSymmetric_;
lduMatrix::solver::addasymMatrixConstructorToTable<FlowFormCuDSS> addCuDSSAsymmetric_;
}

