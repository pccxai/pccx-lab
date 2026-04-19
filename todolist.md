# pccx-lab: 궁극의 NPU 아키텍처 프로파일러 설계서

[Core Identity]

- 아키텍처: Tauri 2.0 (Rust) + React (TypeScript) + WebGL/WebGPU
- 핵심 가치: Zero-Lag, Apple-class Design, AI-Driven Analysis
- 전용 포맷: .pccx (바이너리 프로젝트 파일 - 헤더 Magic Number: PCCX)

[Open Core Strategy & Licensing]

Open Source (Apache 2.0 License):
- 저장소: GitHub Public Repository (hwkim-dev/pccx-lab)
- `ui/` 프론트엔드 쉘 및 기본 시각화 컴포넌트.
- `.pccx` 포맷 파서 및 데이터 규격 명세.
- 플러그인 인터페이스 및 커뮤니티용 기본 노드 세트.

Closed Source (Proprietary License):
- 저장소: GitHub Private Repository (hwkim-dev/pccx-core-private 등)
- `core/` 내 고속 시뮬레이션 및 사이클 예측 엔진.
- Zero-Copy 메모리 브릿지 최적화 로직.
- 온디바이스 로컬 AI 분석 모듈 및 엔터프라이즈 보고서 생성기.

결합 방식: Rust Cargo의 Private Git Dependency 및 Feature Flags를 활용하여, 권한이 있는 빌드 환경에서만 엔터프라이즈 코어가 주입되도록 설계.

[To-Do List]

Phase 1: 고속 데이터 파이프라인 (The Nerve System)
- [ ] Shared Memory Bridge: SharedArrayBuffer를 통한 1:1 메모리 매핑 구축.
- [x] .pccx 포맷 설계: 헤더 매직 넘버 PCCX를 포함한 바이너리 직렬화 시스템.
- [ ] High-speed IPC: 초당 60회 이상 대용량 데이터 스트림 환경 설정.

Phase 2: 극한의 시각화 엔진 (The Visuals)
- [x] WebGL Instanced Renderer: 32x32(1024개) MAC 어레이 및 수만 개의 하드웨어 유닛을 단 1회의 드로우 콜(Draw Call)로 처리하는 엔진 구축.
- [x] Bypass React: 시각화 캔버스는 React의 상태 관리에서 완전히 분리하여 requestAnimationFrame 루프 내에서 직접 렌더링.
- [x] Blender-style Node Editor: React Flow를 사용하여 하드웨어 아키텍처를 시각화하되, 수천 개의 노드에서도 렉이 없는 뷰포트 컬링 최적화 적용.

Phase 3: 확장형 AI 생태계 (The Brains)
- [ ] Dual AI Pipeline: 기본은 클라우드 API(Gemini/Claude)를 사용하되, 보안 환경을 위한 로컬 엔진 지원.
- [ ] Extension Manager: VS Installer 스타일의 UI를 구현하여, 유저가 필요할 때만 로컬 LLM 엔진(llama.cpp 기반) 및 가속 모델을 선택적으로 다운로드 및 활성화.
- [ ] Context Compression: 수백만 라인의 시뮬레이션 로그를 AI가 읽기 쉬운 요약본으로 압축하여 토큰 효율 극대화.

Phase 4: 엔터프라이즈 리포팅 (The Output)
- [ ] Snapshot 엔진: 32K 고해상도로 현재 분석 화면을 캡처하여 메모리에 유지.
- [ ] Professional Report: 캡처된 시각화 데이터와 AI 분석 텍스트를 결합하여 1천만 원짜리 가치를 증명하는 고퀄리티 PDF 보고서 자동 생성.

Phase 5: 라이선스 및 배포 관리 (The Business)
- [ ] License Manager: 오픈소스(Apache 2.0)와 엔터프라이즈(Proprietary) 기능을 분리하는 모듈형 빌드 시스템 및 Feature Flag 설정.
- [ ] Extension Store: VS Installer 스타일의 로컬 AI 모델 및 유료 플러그인 다운로드 모듈.
- [ ] .pccx 세션 관리: 바이너리 파일의 무결성 검증 및 버전 관리 시스템.
