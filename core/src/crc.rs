//! CRC-16/ARC 校验实现（阶段 2 实证，针对手环传输层载荷）
//!
//! 算法参数（来自 docs/protocol/transport.md §4）：
//! - 多项式：poly = 0x8005（反射形式为 0xA001）
//! - 初始值：init = 0x0000
//! - 反射：refin = true, refout = true
//! - 最终异或：xorout = 0x0000
//! - 覆盖范围：仅载荷（第 8 字节到第 8+len-1 字节）
//! - 字节序：字段以小端序存放在帧中
//!
//! 在 RevEng CRC Catalogue 中：
//! - CRC-16/ARC（init=0x0000）的标准 check 向量为 ASCII "123456789" -> 0xBB3D，空输入为 0x0000。
//!   该算法在 baseline-2026-09-08-01 与 baseline-2026-09-08-02 两份抓包中 212/212 非空帧 100% 命中。
//! - CRC-16/MODBUS（init=0xFFFF）的标准 check 向量为 ASCII "123456789" -> 0x4B37。
//!   此处同时提供两个独立向量校验，确保算法与标准定义完全对齐。

/// 计算数据切片的 CRC-16/ARC 校验值（init=0x0000, poly=0x8005, refin=true, refout=true, xorout=0x0000）
pub fn crc16_arc(data: &[u8]) -> u16 {
    let mut crc: u16 = 0x0000;
    for &byte in data {
        crc ^= byte as u16;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

/// 计算数据切片的 CRC-16/MODBUS 校验值（init=0xFFFF, poly=0x8005, refin=true, refout=true, xorout=0x0000）
/// 仅用于对照标准独立已知向量（0x4B37）
#[allow(dead_code)]
pub fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &byte in data {
        crc ^= byte as u16;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc16_arc_empty() {
        assert_eq!(crc16_arc(&[]), 0x0000);
    }

    #[test]
    fn test_crc16_arc_known_vector() {
        // CRC-16/ARC 标准独立向量（RevEng CRC Catalogue 定义：init=0x0000 -> 0xBB3D）
        assert_eq!(crc16_arc(b"123456789"), 0xBB3D);
    }

    #[test]
    fn test_crc16_modbus_reference_vector() {
        // CRC-16/MODBUS 标准独立向量（init=0xFFFF -> 0x4B37）
        assert_eq!(crc16_modbus(b"123456789"), 0x4B37);
    }

    #[test]
    fn test_crc16_arc_real_payload_samples() {
        // 样本 1：会话 1 包 #128 host->band 载荷 (len=6)，来自 transport.md §4 比对表
        // 载荷: 01 02 e7 6d 7c 0d -> 算得值 0x7d3e
        let payload1 = [0x01, 0x02, 0xe7, 0x6d, 0x7c, 0x0d];
        assert_eq!(crc16_arc(&payload1), 0x7d3e);

        // 样本 2：会话 1 包 #142 host->band 载荷 (len=8)，来自 transport.md §4 比对表
        // 载荷: 01 02 e7 6d 7c 60 39 a9 -> 算得值 0xb293
        let payload2 = [0x01, 0x02, 0xe7, 0x6d, 0x7c, 0x60, 0x39, 0xa9];
        assert_eq!(crc16_arc(&payload2), 0xb293);

        // 样本 3：会话 2 包 #137 host->band 载荷 (len=8)，来自 transport.md §4 比对表
        // 载荷: 01 02 8d bd 4d a7 a0 df -> 算得值 0xdd0f
        let payload3 = [0x01, 0x02, 0x8d, 0xbd, 0x4d, 0xa7, 0xa0, 0xdf];
        assert_eq!(crc16_arc(&payload3), 0xdd0f);
    }
}
