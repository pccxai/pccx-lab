fn main() -> anyhow::Result<()> {
    println!("Generating dummy .pccx trace file...");
    pccx_core::simulator::save_dummy_pccx("dummy_trace.pccx")?;
    println!("Saved to dummy_trace.pccx");
    Ok(())
}
