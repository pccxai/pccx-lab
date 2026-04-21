# Rounds Log

One line per completed round.

| Round | Date       | Judge overall | Tickets landed | Commits | Notes |
|-------|------------|---------------|----------------|---------|-------|
| 001   | 2026-04-20 | C-            | T-1, T-2, T-3 (3/3) | 2002e52 judge · 0cad146 research · a814a32 roadmap · fc1e18f/b023eda/7ca9046 T-3 · 42d8e9b/4a9b217 T-2 · c50c3b5/a8ed694/bc88665 T-1 | first cycle; 5 hardcoded-data gaps → 3 real-IPC tickets, all landed |
| 002   | 2026-04-21 | C             | T-1, T-2, T-3 (3/3) | 8e5b99e judge · d3fcf91 research · bb060e2 roadmap · 2310d96/4f324d1/c6ef689 T-1+T-2 core+UI · b2bdb12 T-3 docs+a11y | impl agents hit API limit mid-work; main thread finalised registration + rename fixes |
| 003   | 2026-04-21 | C+            | T-1, T-2, T-3 (3/3) | 1c6cfbb judge · 01b473f research · 46dba46 roadmap · 026374f/ac5adc3 T-1 · 28b60ba T-2 · 3895fc8/04ccf74 T-3     | 6 fake-fixes called out; T-1 killed synthetic_fallback + fixed resolveResource, T-2 ELK layered auto-layout, T-3 real second-trace file picker |
| 004   | 2026-04-21 | B-            | T-1, T-2, T-3 (3/3) | 0c01531 judge · b0ffca8 research · 4eb936f roadmap · 2eaa1d1/64efdc7 T-1 fake-tel kill · 48e0416 T-2 vivado parser · ce76dd8/a4ce541 T-3 flat-buf v2 | tests 39→51; Math.random 20→9; Gemma literal removed; N_LAYERS=0 |
| 005   | 2026-04-21 | B             | T-1, T-2, T-3 (3/3) | 16d7ad1 judge · 4a86005 research · 272d10b roadmap · aa01ed5 T-1 SynthStatusCard · 31d7ea7 T-2 Monaco+Monarch · 679e386 T-3 useLiveWindow hook | 4-round Monaco debt paid; Math.random 20→4 (ornamental only); R6 Judge not fired (user halted loop) |
| 006   | 2026-04-21 | B-            | T-1, T-2, T-3 (3/3) | 8aea83f scripts · bafdd94 App+i18n · 5d3eb43 T-2 Roofline 2.0 · c675880 T-1 step_to_cycle+useCycleCursor · a31905f T-3 scheduler/visibility hooks · dcaa76b T-3 panel rewire | user directive: cycle-granular UI + Roofline extension + Apple-grade 60 fps; all three tickets landed; pre-session main-thread fix for resizable-panels v4 number→px breaking change + copilot i18n leak shipped in 8aea83f/bafdd94 |
