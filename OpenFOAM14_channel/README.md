# OpenFOAM Foundation v14 평행 평판 유로 실습

압력강하를 해석해와 비교하는 등온, 비압축, 정상 층류 예제입니다. 실제 연료전지 유로 치수와 운전조건은 별도로 입력해야 합니다. 다음 명령은 압축을 풀어 생성한 OpenFOAM14_channel 폴더에서 Ubuntu Bash로 실행합니다.

## 실행

    source /opt/openfoam14/etc/bashrc
    sh channel20/Allrun
    cd channel20
    paraFoam

첫 줄은 터미널 세션마다 적용합니다. Allrun은 입력 폴더에서 blockMesh, checkMesh, foamRun, foamPostProcess, Python 3 후처리를 차례로 실행합니다. CFD 계산의 진행 상황은 두 번째 터미널에서 해당 케이스의 log.foamRun을 열어 확인할 수 있습니다. 필요 소프트웨어는 Foundation v14와 Python 3 표준 라이브러리입니다.

## 모델과 기준값

- 두 평판 사이 전체 간격 H = 1 mm, 길이 L = 20 mm, 계산용 압출 폭 b = 1 mm입니다. 앞뒤 두 면에 empty 조건을 주어 폭 방향 변화를 제거합니다. 양옆에 벽이 있는 정사각 관에는 별도 해석해가 필요합니다.
- 좌표는 입구 x = 0, 아래쪽 벽 y = 0입니다. 위아래 벽은 noSlip이고 출구에서 운동학적 압력 p = 0, 속도는 zeroGradient입니다. 입구에서는 완전발달 포물선의 각 면 평균값을 U에 지정하고 p는 zeroGradient입니다.
- 밀도 1.20 kg/m³, 동점성계수 1.50×10⁻⁵ m²/s, 평균속도 1.00 m/s는 연습용 가정입니다. 점성계수 μ = ρν = 1.80×10⁻⁵ Pa s입니다. 등밀도 문제의 p는 Pa 단위 압력을 밀도로 나눈 값입니다.
- η = y/H, u = 6 U평균 η(1−η), 중심 속도 = 1.50 m/s. 압력 손실 기울기는 12 μ U평균/H² = 216 Pa/m, 20 mm 전체 이론 압력강하는 4.32 Pa입니다.
- 첫 격자는 200 × 20 × 1입니다. 벽에 닿지 않는 셀 중심에서 프로파일을 비교하므로 가장 가운데 두 셀의 속도가 정확히 1.50 m/s일 필요는 없습니다.

## 결과 읽기

| 위치 | 확인할 내용 |
|---|---|
| log.checkMesh | Mesh OK와 격자 품질 정보 |
| log.foamRun | U와 p의 잔차 추이, 연속 방정식 오차, 종료 사유 |
| analysis/summary.json | 두 내부 단면의 평균 압력차, 이론값, 상대오차, 속도 분포 상대 L2 오차 |
| analysis/profile.csv | 중간 단면의 y, y/H, CFD 속도, 같은 셀 중심의 이론 속도 |

두 압력 단면은 길이의 1/4과 3/4 부근 셀 중심에 놓입니다. JSON에 실제 x 좌표를 씁니다. 단면 간 거리는 10 mm이므로 이 구간의 이론 압력강하는 216 × 0.010 = 2.16 Pa입니다. tap_dp_Pa는 밀도 × 두 단면의 면적평균 p 차이입니다. 균일한 직교 격자에서는 셀별 단면 면적이 같아 산술평균과 면적평균이 같습니다. L2 상대오차는 [Σ(u_CFD − u_이론)² / Σu_이론²]의 제곱근에 100을 곱한 값입니다.

저장된 phi에 입출구 면 유량이 있으면 Σphi도 읽습니다. OpenFOAM의 면 법선은 바깥 방향이므로 입구 합은 음수, 출구 합은 양수입니다. 유량 불일치율은 100 × |Qin + Qout| / |Qin|입니다. 해당 패치 값이 저장되지 않으면 JSON의 값은 null입니다. 이때 patchFlowRate로 입구, 출구를 따로 평가할 수 있습니다.

## 격자 세분화

다시 압축 해제 폴더의 최상위 디렉터리에서 실행합니다.

    python3 make_case.py run40 --ny 40
    sh run40/Allrun
    python3 make_case.py run80 --ny 80
    sh run80/Allrun

두 방향의 셀 크기를 함께 줄입니다. 각각 4,000개, 16,000개, 64,000개 셀입니다. 세 케이스의 tap_dp_error_percent와 centre_section_Ux_profile_relative_L2_percent, log.foamRun 종료 사유를 비교합니다. 잔차가 충분히 줄기 전에 반복 횟수 한도에 도달했다면 system/controlDict의 endTime과 수렴 추이를 함께 확인하세요. make_case.py는 새 디렉터리에 설정을 만들며 기존 결과를 덮어쓰지 않습니다.

## 검증 범위 및 출처

배포 전에 입력 생성, 패치 방향, 입구 면 평균 유속, 셸 구문, 해석해로 생성한 시험 데이터에 대한 후처리 계산을 확인했습니다. OpenFOAM v14 솔버의 실제 실행 결과는 이 자료에 포함되지 않습니다. 위의 4.32 Pa와 2.16 Pa는 이론 기준값입니다.

- OpenFOAM Foundation / CFD Direct, [v14 공식 첫 예제](https://doc.cfd.direct/openfoam/user-guide-v14/backwardstep), [층류 모델](https://doc.cfd.direct/openfoam/user-guide-v14/turbulence), [후처리](https://doc.cfd.direct/openfoam/user-guide-v14/post-processing-functionality).
- MIT OpenCourseWare, 2.25 Advanced Fluid Mechanics, [Couette & Poiseuille Flows, parallel stationary plates](https://ocw.mit.edu/courses/2-25-advanced-fluid-mechanics-fall-2013/1a114d602956fa0dd328155f9b45f93d_MIT2_25F13_Couet_and_Pois.pdf).
- NASA NPARC Alliance, [격자 수렴성 평가](https://www.grc.nasa.gov/www/wind/valid/tutorial/spatconv.html).
