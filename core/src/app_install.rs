//! 快应用安装协议兼容门面模块 (App Install Compatibility Facade)
//!
//! 该模块重定向至全新的拆分子模块 `core/src/install/`，确保：
//! 1. 既有 `crate::app_install::*` 调用完全兼容，零外部破坏；
//! 2. 单独测试文件通过 `#[path = "../src/app_install.rs"]` 引用时平滑解析；
//! 3. 支持全新的模块化路径（如 `crate::app_install::install::model::*`）。

#[path = "install/mod.rs"]
pub mod install;

pub use install::*;
