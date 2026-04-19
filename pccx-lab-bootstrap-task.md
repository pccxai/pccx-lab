# pccx-lab docs 스켈레톤 세팅 지시서 (for pccx-lab agent)

## 프로젝트 정체성

- repo: `hwkim-dev/pccx-lab` (public)
- 풀네임: **pccx-lab** — a performance simulator and AI-integrated profiler built for the pccx NPU architecture
- 이전 이름 `pccx-uvm-visual-benchmark`에서 변경됨. 새 이름으로만 언급할 것
- 현재 상태: 빈 프로젝트

## 이번 작업의 범위와 제약

**이번 작업은 docs 스켈레톤 세팅이다. 실제 C++/Python 코드는 작성하지 않는다.**

이유: 이 프로젝트의 docs는 pccx 메인 사이트(`https://hwkim-dev.github.io/pccx/`)에 통합 배포될 예정이다. pccx 쪽에서 빌드 파이프라인을 붙이려면 docs 디렉토리 구조가 먼저 확정돼야 한다.

## Counterpart (pccx agent) 측 작업 요약

pccx repo의 agent가 동시에 다음을 세팅하고 있다:

- pccx의 GitHub Actions workflow가 이 repo를 `actions/checkout@v4`로 external checkout
- pccx-lab docs를 `sphinx-build`로 빌드해서 `_site/en/lab/`, `_site/ko/lab/`에 복사
- pccx 사이드바에 "Tools" 섹션 추가, Landing grid에 "Tooling & Lab" 섹션 추가
- pccx footer에 pccx-lab 아이콘 추가

즉 이 repo의 docs는 `https://hwkim-dev.github.io/pccx/en/lab/`에서 서빙된다. 자체 gh-pages 배포는 **설정하지 않는다.**

## 기술 스택 (pccx와 정확히 맞춤)

- Sphinx
- Furo theme
- MyST parser (Markdown 혼용 지원)
- sphinx-design (`grid`, `card`, `dropdown`, `badge`)
- EN/KO 이중 언어 (pccx와 동일 레이아웃)

`docs/requirements.txt` 또는 `pyproject.toml`에 버전 명시. pccx의 `docs/requirements.txt`를 참고해서 동일 버전 사용 (런타임 호환성).

## 디렉토리 구조

```
pccx-lab/
├── docs/
│   ├── conf.py
│   ├── conf_common.py              # (pccx 스타일, EN/KO 공통 설정 추출)
│   ├── Makefile
│   ├── requirements.txt
│   ├── _ext/                       # (optional, 나중에 pccx의 rtl_source 같은 custom extensions)
│   ├── _static/
│   │   └── custom.css
│   ├── _templates/
│   │   └── sidebar/
│   │       └── brand.html
│   ├── index.rst                   # EN 루트
│   ├── overview.rst
│   ├── architecture/
│   │   ├── index.rst
│   │   ├── core.rst                # V-Simulate engine
│   │   ├── ui.rst                  # Dear ImGui/ImPlot/ImNodes
│   │   ├── uvm_bridge.rst          # DPI-C + UVM
│   │   └── ai_copilot.rst          # LLM bridge + data exporter
│   ├── phases/
│   │   ├── index.rst
│   │   ├── phase1_vsimulate.rst
│   │   ├── phase2_timeline.rst
│   │   ├── phase3_profiling.rst
│   │   ├── phase4_uvm_cosim.rst
│   │   └── phase5_ai_copilot.rst
│   ├── design/
│   │   ├── index.rst
│   │   ├── rationale.rst
│   │   └── module_boundaries.rst
│   └── ko/                         # 한국어 미러 (pccx와 동일 패턴)
│       ├── conf.py
│       ├── index.rst
│       ├── overview.rst
│       ├── architecture/
│       ├── phases/
│       └── design/
├── src/
│   ├── core/.gitkeep
│   ├── ui/.gitkeep
│   ├── uvm_bridge/.gitkeep
│   └── ai_copilot/.gitkeep
├── README.md
├── .gitignore
└── LICENSE
```

**`src/` 하위 디렉토리는 `.gitkeep` 파일만 넣고 커밋.** 이유: 모듈 경계가 repo 구조에 처음부터 찍혀있어야 나중 개발 시 일관성 유지 가능.

## 핵심 설계 원칙 (docs에 반드시 반영)

### A. 모노레포 결정 근거 → `design/rationale.rst`

원래 계획은 "pccx-uvm-visual-benchmark"라는 좁은 툴이었으나, 5 phase 전부를 하나의 repo `pccx-lab`으로 통합하기로 결정. 아래 세 가지 이유를 본문에 서술:

1. **Phase 구조가 계층적이다.** Phase 4~5 (UVM co-sim, AI Copilot)는 Phase 1~3 (core engine, timeline, profiling viewer) 위에 얹히는 구조. 분리하면 인위적인 API 경계만 생기고 혼자 개발하는 입장에서 유지보수 비용이 크다.

2. **핵심 차별화가 통합 경험에 있다.** "분석 → AI 질문 → 테스트벤치 생성"이 한 화면에서 일어나는 것이 이 툴의 진짜 가치다. 설계서 2.2절의 문제 정의 자체가 통합 UX를 전제한다. 분리하면 이 경험이 죽는다.

3. **릴리스 전략으로 해결 가능한 문제다.** "Phase 1~3 먼저 쓸 만하게 내놓기"는 repo 분리 없이 `pccx-lab v0.1`에 Phase 1~3만 포함하는 식으로 해결 가능하다. 조기 분리는 잘못된 추상화를 영구화할 위험이 있다.

마지막 문단: "언젠가 analyzer만 떼어내서 별도로 배포할 필요가 생기면 그때 분리해도 늦지 않다. 반대 방향(합치기)은 훨씬 어렵다."

### B. 내부 모듈 경계 → `design/module_boundaries.rst`

repo는 하나지만 코드 레벨 모듈은 엄격히 분리한다. 각 모듈의 역할과 의존성 방향:

```
core/         V-Simulate 에뮬레이터, cycle estimator, trace logger
              → 다른 모듈에 대한 의존성 없음 (완전 standalone)

ui/           Dear ImGui / ImPlot / ImNodes 기반 시각화
              → core/의 trace 데이터만 읽음 (read-only 의존)

uvm_bridge/   DPI-C 인터페이스, SystemVerilog co-simulation
              → core/를 동적 라이브러리로 감싸는 얇은 레이어

ai_copilot/   FastAPI AI bridge, LLM API 연동
              → core/ + ui/의 데이터를 JSON/YAML로 직렬화 (read-only)
```

의존성 규칙: **`ui/`, `uvm_bridge/`, `ai_copilot/`는 `core/`에만 의존. 서로는 직접 의존하지 않는다.** UI와 AI copilot 간 통신이 필요하면 `core/`의 event bus 또는 trace 파일을 매개로.

이 경계를 깨지 말 것. 깨지는 순간 "analyzer만 떼어내기"가 불가능해진다.

## 각 페이지 작성 가이드

### `index.rst` — EN 루트 (가장 중요)

이 페이지는 **유입 퍼널 설계의 핵심 지점**이다. 첫 문장은 반드시 pccx와의 관계를 선언해야 한다.

```rst
pccx-lab
========

**pccx-lab** is a performance simulator and AI-integrated profiler
built for the `pccx NPU architecture <https://hwkim-dev.github.io/pccx/>`_.

It provides pre-RTL bottleneck identification, UVM co-simulation
scoreboards, and LLM-driven testbench generation — all in a single
workflow.

.. admonition:: Work in Progress
   :class: warning

   pccx-lab is currently in active design. This documentation covers the
   planned architecture and 5-phase roadmap. See `Roadmap <phases/index.html>`_
   for current status.
```

그 아래에 grid 2개:

```rst
.. grid:: 1 1 2 2
   :margin: 3
   :gutter: 3

   .. grid-item-card:: 🏗 Architecture
      :link: architecture/index
      :link-type: doc

      Module layout, dataflow, and integration with pccx RTL.

   .. grid-item-card:: 🗺 5-Phase Roadmap
      :link: phases/index
      :link-type: doc

      V-Simulate → Timeline → Profiling → UVM co-sim → AI Copilot.
```

페이지 맨 아래에 prominent back-link section:

```rst
----

**Part of the pccx ecosystem.** See also:

* `pccx architecture docs <https://hwkim-dev.github.io/pccx/>`_ — NPU design reference
* `pccx-FPGA-NPU-LLM-kv260 <https://github.com/hwkim-dev/pccx-FPGA-NPU-LLM-kv260>`_ — RTL implementation
```

KO 동일 패턴으로 `ko/index.rst`에 작성.

### architecture 하위 페이지 (core/ui/uvm_bridge/ai_copilot)

템플릿:

```rst
Core Engine (V-Simulate)
========================

.. admonition:: Under Active Design
   :class: warning

   Content below is a placeholder describing planned scope.

Purpose
-------
C++20 기반 하드웨어 에뮬레이터. pccx NPU의 사이클-정확 시뮬레이션과
trace 수집을 담당한다.

Responsibilities
----------------
* 하드웨어 모델링 (MAC Array, BRAM, AXI Bus 대역폭 추상화)
* Cycle Estimator — 타일링 단위 연산 사이클 수학적 모델링
* Trace Logger — 명령어 타임스탬프 및 리소스 점유 상태 기록
* JSON 또는 Perfetto .pftrace 호환 포맷으로 trace 직렬화

External interfaces
-------------------
* ``ui/`` — trace 파일 read-only 제공
* ``uvm_bridge/`` — DPI-C export 함수로 감싸짐
* ``ai_copilot/`` — JSON/YAML 요약본 제공

Module boundary
---------------
다른 모듈에 대한 의존성 없음. 이 모듈만 뽑아서 CLI 툴로도 사용 가능해야 함.

Status
------
:bdg-secondary:`Not started` — Phase 1 대상
```

각 모듈 페이지는 이 형식에 맞춰 작성. 내용은 첨부된 원본 설계서(todolist.md)의 해당 절에서 추출. 아직 결정 안 된 건 "TBD"로 명시.

### phases 하위 페이지 (1~5)

템플릿:

```rst
Phase 1: V-Simulate (Core Engine)
=================================

:bdg-secondary:`Not started`

Goal
----
백엔드 연산 모델을 정확히 구축하여, 이후 phase들의 기반이 되는
trace 데이터를 생성할 수 있도록 한다.

Deliverables
------------
* [ ] ``core/hw_model.hpp`` — pccx MAC Array, BRAM, AXI Bus 추상화 클래스
* [ ] ``core/cycle_estimator.hpp`` — 타일링 단위 사이클 계산
* [ ] ``core/trace_logger.hpp`` — 타임스탬프 + 리소스 점유 기록
* [ ] Perfetto .pftrace 호환 출력 검증

Depends on
----------
(None — Phase 1은 기반 단계)

Enables
-------
* Phase 2 (timeline viewer가 이 trace를 소비)
* Phase 4 (UVM bridge가 이 엔진을 DPI-C로 감쌈)
```

Phase 1~5 전부 이 형식으로. 내용은 설계서 4절(단계별 개발 로드맵)에서 추출.

### `overview.rst`

Mermaid 다이어그램으로 5 phase를 레이어드 뷰로 표현:

```rst
System Overview
===============

.. mermaid::

   graph TB
       subgraph "Phase 5: AI Copilot"
           AI["ai_copilot/<br/>LLM bridge + testbench gen"]
       end
       subgraph "Phase 4: UVM Co-sim"
           UVM["uvm_bridge/<br/>DPI-C + Scoreboard"]
       end
       subgraph "Phase 2-3: Visualization"
           UI["ui/<br/>Timeline + Roofline + Memory viz"]
       end
       subgraph "Phase 1: Core"
           CORE["core/<br/>V-Simulate + Trace"]
       end
       UI --> CORE
       UVM --> CORE
       AI --> CORE
       AI --> UI
```

## Furo 테마 커스터마이징 (pccx 스타일 계승)

### `_templates/sidebar/brand.html`

pccx의 brand.html과 유사한 구조 (언어 스위처 + pill row), **단 pill row 내용은 다름:**

- `← pccx docs` → `https://hwkim-dev.github.io/pccx/en/` (primary — 메인으로 복귀 장치)
- `Code` → `https://github.com/hwkim-dev/pccx-lab`
- `Author` → `https://hwkim-dev.github.io/hwkim-dev/`

첫 번째 링크(`← pccx docs`)는 시각적으로 강조. 이 링크가 pccx-lab 방문자가 pccx 본 문서로 역유입되는 핵심 동선이다.

### Footer 아이콘

3개:
- 📘 Docs source (이 repo)
- 🏗 **pccx** (parent architecture) — primary back-link, 시각적 강조
- 👤 Author

pccx의 footer와 다른 점: `🏗 pccx`가 중앙 강조 아이콘.

### `_static/custom.css`

pccx의 custom.css를 기반으로 하되, "Work in Progress" warning 스타일과 `← pccx docs` pill 강조 스타일 추가.

## `conf.py` 핵심 설정

```python
# docs/conf.py (EN)
import os, sys
sys.path.insert(0, os.path.abspath('_ext'))

project = 'pccx-lab'
author = 'hwkim'
copyright = '2026, hwkim'
release = '0.0.0'

extensions = [
    'myst_parser',
    'sphinx_design',
    'sphinx.ext.intersphinx',
    'sphinxcontrib.mermaid',
]

intersphinx_mapping = {
    'pccx': ('https://hwkim-dev.github.io/pccx/en/', None),
}

html_theme = 'furo'
html_title = 'pccx-lab'
html_baseurl = 'https://hwkim-dev.github.io/pccx/en/lab/'

html_theme_options = {
    'footer_icons': [
        {
            'name': 'Docs source',
            'url': 'https://github.com/hwkim-dev/pccx-lab',
            'html': '<svg>...</svg>',
        },
        {
            'name': 'pccx',
            'url': 'https://hwkim-dev.github.io/pccx/en/',
            'html': '<svg>...</svg>',
            'class': 'footer-icon-primary',
        },
        {
            'name': 'Author',
            'url': 'https://hwkim-dev.github.io/hwkim-dev/',
            'html': '<svg>...</svg>',
        },
    ],
    # 기타 pccx와 동일 옵션
}

html_static_path = ['_static']
html_css_files = ['custom.css']
```

KO (`docs/ko/conf.py`)는 `language = 'ko'` + `html_baseurl = 'https://hwkim-dev.github.io/pccx/ko/lab/'` + intersphinx KO URL.

## `README.md`

간단히:

```markdown
# pccx-lab

Performance simulator and AI-integrated profiler, built for the
[pccx NPU architecture](https://hwkim-dev.github.io/pccx/).

**Status:** 🚧 Work in progress — docs scaffolding only, no runtime code yet.

## What this is

A pre-RTL bottleneck analyzer, UVM co-simulation scoreboard, and
LLM-driven testbench generator for pccx. See
[full docs](https://hwkim-dev.github.io/pccx/en/lab/) for architecture
and 5-phase roadmap.

## Tech stack (planned)

- C++20 core engine with Vulkan Compute for dataflow emulation
- Dear ImGui + ImPlot + ImNodes for visualization
- FastAPI + LLM APIs for AI copilot integration
- SystemVerilog DPI-C for UVM bridge

## Module layout

- `core/` — V-Simulate emulator, cycle estimator, trace logger
- `ui/` — ImGui/ImPlot/ImNodes visualization layer
- `uvm_bridge/` — DPI-C interface for UVM co-simulation
- `ai_copilot/` — LLM bridge, JSON exporter, testbench generator

See [design rationale](https://hwkim-dev.github.io/pccx/en/lab/design/rationale.html)
for why these are in one repo.

## Local docs preview

    cd docs
    pip install -r requirements.txt
    make html
    # Open _build/html/index.html

## Related

- [pccx](https://github.com/hwkim-dev/pccx) — NPU architecture docs
- [pccx-FPGA-NPU-LLM-kv260](https://github.com/hwkim-dev/pccx-FPGA-NPU-LLM-kv260) — RTL implementation
```

## 완료 기준

- [ ] `cd docs && make html` 로컬 빌드 성공 (EN)
- [ ] `sphinx-build -b html docs/ko _build/html_ko` 로컬 빌드 성공 (KO)
- [ ] 모든 페이지에 "Work in Progress" admonition 또는 badge 표시
- [ ] pccx 메인 docs 백링크가 사이드바 pill / footer icon / index.rst 하단 세 지점에 존재
- [ ] `design/rationale.rst`에 모노레포 결정 근거 3가지 명시
- [ ] `design/module_boundaries.rst`에 모듈 의존성 규칙 명시
- [ ] `src/core/`, `src/ui/`, `src/uvm_bridge/`, `src/ai_copilot/`가 `.gitkeep`으로 repo에 커밋됨
- [ ] `html_baseurl`이 `https://hwkim-dev.github.io/pccx/en/lab/` 및 `.../ko/lab/`로 설정됨
- [ ] Mermaid diagram 렌더 확인 (`overview.rst`)

## 하지 말 것

- 실제 C++/Python 코드 작성 (docs 세팅만)
- 자체 GitHub Pages gh-pages 배포 설정 (`_config.yml`, gh-pages workflow 등)
- pccx repo 내부 파일 수정 (counterpart agent 영역)
- `html_baseurl`을 다른 값으로 설정 (반드시 pccx 사이트 경로)

## 첨부: 설계서 원문 참조

내용 추출 시 참고할 원본 설계서는 `pccx-analyzer` 프로젝트 todolist.md (이 repo의 초기 설계 문서). 해당 문서의 기술적 결정은 거의 그대로 pccx-lab에 이식. 다만 다음 두 가지는 변경됨:

1. 프로젝트 이름: `pccx-analyzer` / `pccx-uvm-visual-benchmark` → **`pccx-lab`**
2. Phase 1~3과 4~5의 분리 계획 → **전부 통합된 하나의 툴**
