fn main() {
    println!("cargo:rustc-env=NETAPE_BUILD_TARGET={}", std::env::var("TARGET").unwrap());
    println!("cargo:rustc-check-cfg=cfg(feature, values(\"cargo-clippy\"))");
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let index = dist.join("index.html");
    let html = std::fs::read_to_string(&index)
        .expect("dist/index.html is missing. Run npm run build from the project root before cargo run. Do not run frontend and Cargo builds in parallel.");
    // Fail the build if Vite's output was cleared or is incomplete, rather than
    // producing an executable which opens with 'asset not found: index.html'.
    assert!(!html.is_empty(), "dist/index.html is empty; run npm run build first");
    for attribute in ["src=\"/assets/", "href=\"/assets/"] {
        for suffix in html.split(attribute).skip(1) {
            let file = suffix.split('"').next().unwrap();
            assert!(dist.join("assets").join(file).is_file(), "frontend asset is missing: {file}; run npm run build first");
        }
    }
    tauri_build::try_build(
        tauri_build::Attributes::new().codegen(tauri_build::CodegenContext::new()),
    ).expect("failed to generate Tauri context and embed frontend assets");
}
