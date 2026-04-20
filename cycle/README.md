# pccx-lab Cyclic Self-Evolution System

This directory holds the artefacts produced by a recurring 4-role agent
loop that drives pccx-lab forward without human prompting.

## Roles

1. **Judge (external reviewer)** — `agents/judge.md`. Compares pccx-lab
   honestly against commercial tools: Siemens Questa, Synopsys VCS /
   Verdi, Cadence Xcelium / SimVision, NVIDIA Nsight Systems / Compute,
   Intel VTune, AMD uProf, Xilinx Vitis Analyzer / Vivado XSIM, Signal
   Tap / ILA, ChipScope, GTKWave, Surfer, etc. Scores UI, ISA
   validation, API integrity, UVM coverage, FPGA verification, ASIC
   verification, GPU analysis, docs. Output is a signed critique in
   `round_NNN/judge_report.md`.

2. **Research (SOTA scout)** — `agents/research.md`. Surveys arxiv,
   IEEE, ACM, Xilinx / AMD / Intel / NVIDIA official docs. Returns
   canonical citations for every claim. Output:
   `round_NNN/research_findings.md`.

3. **Planner (roadmap)** — `agents/planner.md`. Reads judge + research
   and turns weaknesses into concrete implementation tickets (file
   paths, file-level diffs, acceptance criteria). Output:
   `round_NNN/roadmap.md`.

4. **Implementers** — `agents/implementer_ui.md`,
   `agents/implementer_core.md`, `agents/implementer_bridge.md`.
   Execute the top tickets of `roadmap.md` in isolated worktrees,
   report diff + test results in `round_NNN/implemented.md`.

## Loop

```
cycle N:   judge → research → planner → implementers → judge (N+1)
```

The judge of cycle N+1 is given judge_report_N + implemented_N so it
can grade *progress* as well as absolute quality.

## Driver

`cycle/driver.md` is meant to be fed to `/loop` (dynamic pacing). It
tells the orchestrator Claude which round to run next, where the
prior artefacts live, and when the loop should halt.

## Round index

See `ROUNDS.md` for the running summary of findings, velocity, and
unresolved gaps.
