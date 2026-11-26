#!/usr/bin/env python3
"""Compare ASCII OpenFOAM fields against the plane Poiseuille solution."""

import csv
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path


def read_values(text, keyword, kind, count):
    comp = 3 if kind == "vector" else 1
    block = re.search(
        rf"\b{keyword}\s+nonuniform\s+List<\s*{kind}\s*>\s+(\d+)"
        r"\s*\((.*?)\)\s*;", text, re.DOTALL,
    )
    if block:
        flat = [float(x) for x in re.findall(r"[-+]?(?:\d*\.?\d+|\d+\.)(?:[eE][-+]?\d+)?", block[2])]
        if int(block[1]) != count or len(flat) != count * comp:
            raise ValueError(f"Unexpected {keyword} size; expected {count} {kind} entries.")
        return [tuple(flat[j:j+3]) for j in range(0, len(flat), 3)] if comp == 3 else flat
    value = re.search(rf"\b{keyword}\s+uniform\s+([^;]+);", text)
    if value:
        row = tuple(float(x) for x in value[1].strip().strip("()").split())
        if len(row) == comp:
            return [row if comp == 3 else row[0]] * count
    raise ValueError(f"Cannot read {keyword}. This checker expects the case's ASCII output.")


def patch_flow(text, patch, ny):
    patch_data = re.search(rf"\b{patch}\s*\{{([^{{}}]*)\}}", text, re.DOTALL)
    if patch_data and re.search(r"\bvalue\s+(?:nonuniform|uniform)\b", patch_data[1]):
        return sum(read_values(patch_data[1], "value", "scalar", ny))
    return None


def latest_written_time(case):
    candidates = []
    for entry in case.iterdir():
        if not entry.is_dir():
            continue
        try:
            instant = float(entry.name)
        except ValueError:
            continue
        if instant > 0 and (entry / "U").is_file() and (entry / "p").is_file():
            candidates.append((instant, entry))
    if not candidates:
        raise ValueError("No computed U and p fields found. Run foamRun first.")
    return max(candidates)[1]


def main():
    case = Path(__file__).resolve().parent
    spec = json.loads((case / "benchmark.json").read_text())
    nx, ny = spec["nx"], spec["ny"]
    h, length = spec["height_m"], spec["length_m"]
    rho, nu, mean = spec["rho_kg_m3"], spec["nu_m2_s"], spec["u_mean_m_s"]
    time = latest_written_time(case)
    centre_file = time / "C"
    if not centre_file.is_file():
        raise ValueError("Missing cell centres C. Run foamPostProcess -latestTime -func writeCellCentres.")
    n = nx * ny
    centres = read_values(centre_file.read_text(), "internalField", "vector", n)
    velocity = read_values((time / "U").read_text(), "internalField", "vector", n)
    pressure = read_values((time / "p").read_text(), "internalField", "scalar", n)
    sections = defaultdict(list)
    for idx, (x, y, _) in enumerate(centres):
        sections[round(x, 12)].append((y, velocity[idx][0], pressure[idx]))
    xs = sorted(sections)
    if len(xs) != nx or any(len(rows) != ny for rows in sections.values()):
        raise ValueError("Cell coordinates do not match the specified uniform mesh.")

    ia = nx // 4
    ib = ia + nx // 2
    xa, xb = xs[ia], xs[ib]
    p_a = statistics.mean(row[2] for row in sections[xa])
    p_b = statistics.mean(row[2] for row in sections[xb])
    dp_measured = rho * (p_a - p_b)
    gradient_ref = 12 * rho * nu * mean / h**2
    dp_ref = gradient_ref * (xb - xa)

    exports = case / "analysis"
    exports.mkdir(exist_ok=True)
    numerator = denominator = 0.0
    with (exports / "profile.csv").open("w", newline="") as output:
        rows = csv.writer(output)
        rows.writerow(("y_m", "y_over_H", "Ux_CFD_m_s", "Ux_exact_at_centre_m_s"))
        for y, ux, _ in sorted(sections[xs[nx//2]]):
            eta = y / h
            exact = 6 * mean * eta * (1 - eta)
            rows.writerow((y, eta, ux, exact))
            numerator += (ux - exact)**2
            denominator += exact**2
    phi_file = time / "phi"
    q_in = q_out = imbalance = None
    if phi_file.is_file():
        flux = phi_file.read_text()
        q_in = patch_flow(flux, "inlet", ny)
        q_out = patch_flow(flux, "outlet", ny)
        if q_in is not None and q_out is not None and q_in != 0:
            imbalance = 100 * abs(q_in + q_out) / abs(q_in)
    result = {
        "time_directory": time.name, "cells": n, "tap_a_x_m": xa, "tap_b_x_m": xb,
        "tap_dp_Pa": dp_measured, "tap_dp_exact_Pa": dp_ref,
        "tap_dp_error_percent": 100 * abs(dp_measured - dp_ref) / dp_ref,
        "loss_gradient_CFD_Pa_per_m": dp_measured / (xb - xa),
        "loss_gradient_exact_Pa_per_m": gradient_ref,
        "full_length_dp_exact_Pa": gradient_ref * length,
        "centre_section_Ux_profile_relative_L2_percent": 100 * math.sqrt(numerator / denominator),
        "inlet_phi_outward_m3_s": q_in, "outlet_phi_outward_m3_s": q_out,
        "boundary_flux_imbalance_percent": imbalance,
    }
    report = json.dumps(result, indent=2, allow_nan=False)
    (exports / "summary.json").write_text(report + "\n")
    print(report)
    print("CSV and JSON saved in", exports)
    if imbalance is None:
        print("Boundary phi values unavailable. The flux-imbalance metric is left empty.")


if __name__ == "__main__":
    main()
