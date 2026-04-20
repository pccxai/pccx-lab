"""End-to-end verification that a .pccx produced from a pccx-FPGA testbench
run is correctly ingested by the pccx-lab native app via Tauri IPC.

This test only runs if the bridge artefact exists at the known location
(hw/sim/work/tb_packer.pccx under the sibling pccx-FPGA repo). If it is
missing, the test is skipped — this keeps the pccx-lab suite usable in
isolation while still wiring up the full verification loop when both
repos are checked out side-by-side.
"""

from pathlib import Path

import pytest


SIBLING_PCCX = (
    Path(__file__).resolve().parents[4]
    / "pccx-FPGA-NPU-LLM-kv260"
    / "hw"
    / "sim"
    / "work"
    / "tb_packer.pccx"
)


def _invoke(driver, command: str, args: dict) -> dict:
    """Invoke a Tauri command via the in-page IPC bridge and return its result."""
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
    driver.set_script_timeout(15)
    return driver.execute_async_script(script, command, args)


@pytest.mark.skipif(not SIBLING_PCCX.exists(),
                    reason=f"bridge artefact missing: {SIBLING_PCCX}")
def test_load_tb_packer_trace(driver):
    res = _invoke(driver, "load_pccx", {"path": str(SIBLING_PCCX)})
    assert res["ok"], f"load_pccx failed: {res.get('err')}"

    header = res["value"]
    assert "xsim-bridge" in header["pccx_lab_version"], header
    assert "PASS" in header["pccx_lab_version"], header
    assert header["trace"]["cycles"] == 1024
    assert header["trace"]["cores"] == 1
    assert header["payload"]["encoding"] == "bincode"


@pytest.mark.skipif(not SIBLING_PCCX.exists(),
                    reason=f"bridge artefact missing: {SIBLING_PCCX}")
def test_core_utilisation_after_load(driver):
    load = _invoke(driver, "load_pccx", {"path": str(SIBLING_PCCX)})
    assert load["ok"], load

    util = _invoke(driver, "get_core_utilisation", {})
    assert util["ok"], f"get_core_utilisation failed: {util.get('err')}"

    payload = util["value"]
    assert payload["total_cycles"] == 1024
    assert len(payload["core_utils"]) >= 1
    # tb_packer drives the single DSP continuously — utilisation should be high.
    core0 = next(c for c in payload["core_utils"] if c["core_id"] == 0)
    assert core0["util_pct"] > 50.0, f"unexpectedly low util: {core0}"
