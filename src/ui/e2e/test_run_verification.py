"""E2E for the run_verification Tauri command.

Spawns the full pccx-FPGA testbench suite via the Rust shim, then
asserts the parsed summary matches the three tbs we expect and that
each one reports a reachable .pccx artefact."""

from pathlib import Path

import pytest

SIBLING_FPGA = Path(__file__).resolve().parents[4] / "pccx-FPGA-NPU-LLM-kv260"
RUN_SCRIPT   = SIBLING_FPGA / "hw" / "sim" / "run_verification.sh"


def _invoke(driver, command: str, args: dict) -> dict:
    script = """
    const callback = arguments[arguments.length - 1];
    const cmd = arguments[0];
    const params = arguments[1];
    const bridge = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
                || (window.__TAURI__ && window.__TAURI__.invoke);
    if (!bridge) {
        callback({ok: false, err: 'Tauri invoke bridge not on window'});
        return;
    }
    bridge(cmd, params)
        .then(v => callback({ok: true, value: v}))
        .catch(e => callback({ok: false, err: String(e)}));
    """
    # xsim runs × 3 can take ~10 s, so give the call a generous ceiling.
    driver.set_script_timeout(120)
    return driver.execute_async_script(script, command, args)


@pytest.mark.skipif(not RUN_SCRIPT.exists(),
                    reason=f"bridge script missing: {RUN_SCRIPT}")
def test_run_verification_full_suite(driver):
    res = _invoke(driver, "run_verification", {"repoPath": str(SIBLING_FPGA)})
    assert res["ok"], f"run_verification failed: {res.get('err')}"

    summary = res["value"]
    names = {tb["name"] for tb in summary["testbenches"]}
    # Expected names from the current verification suite — this will grow
    # as more benches land; the assertion only requires the known ones.
    assert "tb_GEMM_dsp_packer_sign_recovery" in names, names
    assert "tb_mat_result_normalizer"         in names, names
    assert "tb_GEMM_weight_dispatcher"        in names, names

    # Every tb should have reported PASS and a reachable .pccx trace.
    for tb in summary["testbenches"]:
        assert tb["verdict"] == "PASS", tb
        assert tb["cycles"]  > 0,       tb
        assert tb["pccx_path"] is not None, tb
        assert Path(tb["pccx_path"]).is_file(), tb

    # Synth status reflects the current known-failure; the field is a
    # tri-state (Some(true) / Some(false) / None) so accept either truth
    # value but insist it got populated.
    assert summary["synth_timing_met"] in (True, False), summary
