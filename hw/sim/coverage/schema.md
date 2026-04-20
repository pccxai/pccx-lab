# pccx Coverage JSONL Schema

Emitted by each pccx-FPGA testbench; consumed by the pccx-lab
`coverage::merge_jsonl` function and surfaced in the UI's UVM
Coverage panel. One record per line (strict JSONL — no pretty-print,
no multi-line objects).

Blank lines and lines starting with `#` are ignored so runs can carry
human-readable headers.

## Bin record

```json
{"group": "gemm_tile_shape", "bin": "32x32", "hits": 17, "goal": 20}
```

| Field   | Type   | Required | Notes                                                        |
| ------- | ------ | -------- | ------------------------------------------------------------ |
| `group` | string | yes      | Coverpoint name. Must match a v002 coverpoint (see below).   |
| `bin`   | string | yes      | Bin label within the coverpoint. Free-form string.           |
| `hits`  | u64    | yes      | Count of samples that fell in this bin during the run.       |
| `goal`  | u64    | no       | Target hit count for 100%. When missing, merged `goal` = 0.  |

Merge semantics: `hits` are **summed** across runs (UCIS count-based
merge); `goal` is retained as the **max** observed value — any run
declaring a higher goal wins. This keeps goal revisions forward-
compatible with older runs that ship no goal at all.

## Cross record

```json
{"cross": ["gemm_k_stride", "mem_hp_backpressure"],
 "a_bin": "4", "b_bin": "hi", "hits": 5, "goal": 8}
```

| Field   | Type              | Required | Notes                                    |
| ------- | ----------------- | -------- | ---------------------------------------- |
| `cross` | `[string, string]` | yes      | `(group_a, group_b)` being crossed.      |
| `a_bin` | string            | yes      | Bin within `group_a`.                    |
| `b_bin` | string            | yes      | Bin within `group_b`.                    |
| `hits`  | u64               | yes      | Joint samples.                           |
| `goal`  | u64               | no       | Optional per-tuple goal.                 |

Merge semantics identical to bin records (sum hits, max goal). The
pccx-lab UI renders the `(gemm_k_stride × mem_hp_backpressure)` cross
as an 8×4 heatmap.

## v002 canonical coverpoints

Driven from `VerificationSuite.tsx` prior to T-2 hard-coding removal:

- `gemm_tile_shape`, `gemm_k_stride`, `gemm_accum_roll` (MAT_CORE)
- `gemv_lane_sel`, `gemv_reduce_tree` (VEC_CORE)
- `sfu_op_kind`, `sfu_exp_range` (SFU)
- `mem_axi_burst_len`, `mem_hp_backpressure`, `mem_uram_bank_hit`
  (MEM_ctrl)
- `ctrl_isa_opcode`, `ctrl_barrier_kind`, `ctrl_dispatch_credit`
  (frontend)

## Future extensions

Records that match neither shape are silently dropped — reserved for
future additions (e.g. FSM coverage, assertion-hit counters). Consumers
must not rely on that behaviour; emit only the two shapes above.

## Reference fixtures

`hw/sim/coverage/fixtures/run_{a,b,c}.jsonl` — three synthetic dumps
exercising the merge:
- **run_a** — short smoke workload (2k cycles),
- **run_b** — medium workload (10k cycles),
- **run_c** — long soak (100k cycles) with the full cross matrix.
