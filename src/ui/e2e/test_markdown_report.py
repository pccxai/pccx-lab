"""E2E for the generate_markdown_report Tauri command.

Loads a small .pccx into the app state and asks the Rust side to render
a Markdown summary. Verifies the headings we promise users show up and
the synth-free path also renders cleanly."""

from pathlib import Path

import pytest

SIBLING_FPGA = Path(__file__).resolve().parents[4] / "pccx-FPGA-NPU-LLM-kv260"
TRACE_PATH   = SIBLING_FPGA / "hw" / "sim" / "work" / "tb_packer.pccx"
UTIL_PATH    = SIBLING_FPGA / "hw" / "build" / "reports" / "utilization_post_synth.rpt"
TIMING_PATH  = SIBLING_FPGA / "hw" / "build" / "reports" / "timing_summary_post_synth.rpt"


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
    driver.set_script_timeout(15)
    return driver.execute_async_script(script, command, args)


@pytest.mark.skipif(
    not (TRACE_PATH.exists() and UTIL_PATH.exists() and TIMING_PATH.exists()),
    reason="sibling artefacts missing",
)
def test_full_report_has_all_sections(driver):
    load = _invoke(driver, "load_pccx", {"path": str(TRACE_PATH)})
    assert load["ok"], load

    res = _invoke(driver, "generate_markdown_report", {
        "utilizationPath": str(UTIL_PATH),
        "timingPath":      str(TIMING_PATH),
    })
    assert res["ok"], f"generate_markdown_report failed: {res.get('err')}"

    md: str = res["value"]
    # Headings the workflow doc promises users will get.
    assert "# pccx verification report"  in md, md[:500]
    assert "## Trace summary"            in md, md[:500]
    assert "## Roofline"                 in md, md[:500]
    assert "## Synthesis status"         in md, md[:500]
    # The tb_packer trace is 1024 MAC cycles on core 0.
    assert "Total cycles:** 1024"        in md, md[:500]
    assert "`MAC_COMPUTE`"               in md
    # The live synth run is known to miss timing — must surface that.
    assert "Timing NOT met" in md, md[-400:]


@pytest.mark.skipif(not TRACE_PATH.exists(), reason="trace artefact missing")
def test_trace_only_report_skips_synth(driver):
    load = _invoke(driver, "load_pccx", {"path": str(TRACE_PATH)})
    assert load["ok"], load

    res = _invoke(driver, "generate_markdown_report",
                  {"utilizationPath": "", "timingPath": ""})
    assert res["ok"], res

    md: str = res["value"]
    assert "## Trace summary"     in md, md[:500]
    assert "## Roofline"          in md, md[:500]
    assert "## Synthesis status" not in md, "synth section must be omitted when paths are empty"


def test_empty_report_fails_cleanly(driver):
    # With no trace loaded and empty synth paths, the command should
    # refuse rather than silently emit an empty report.
    # (We can't guarantee no prior test loaded a trace into the session,
    # so we allow either outcome but require the error message on failure
    # to be actionable.)
    res = _invoke(driver, "generate_markdown_report",
                  {"utilizationPath": "", "timingPath": ""})
    if res["ok"]:
        assert res["value"].startswith("# pccx verification report"), res["value"][:100]
    else:
        assert "trace" in res["err"].lower() or "synth" in res["err"].lower(), res["err"]
