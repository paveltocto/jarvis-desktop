//! CPU, memory, disk and process figures (legacy `system_monitor`). `sysinfo`
//! is cross-platform, so this does not belong in the platform layer.

use serde::Serialize;
use sysinfo::{Disks, MINIMUM_CPU_UPDATE_INTERVAL, ProcessesToUpdate, System};

const MAX_PROCESSES: usize = 15;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub mount_point: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    pub name: String,
    /// Percent of one core, so a busy multi-threaded process can exceed 100.
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub disks: Vec<DiskStats>,
    pub processes: Vec<ProcessStats>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessSort {
    Cpu,
    Memory,
}

/// Takes a sample. Blocks for the short interval CPU usage needs.
pub fn sample(sort: ProcessSort, process_count: usize) -> Result<SystemStats, String> {
    let mut system =
        System::new().map_err(|error| format!("system figures are unavailable: {error}"))?;
    system.refresh_cpu_usage();
    system.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();
    system.refresh_processes(ProcessesToUpdate::All, true);
    system.refresh_memory();

    let mut processes: Vec<_> = system
        .processes()
        .values()
        // On Linux threads are listed too; they would repeat their process.
        .filter(|process| process.thread_kind().is_none())
        .map(|process| ProcessStats {
            name: process.name().to_string_lossy().into_owned(),
            cpu_percent: process.cpu_usage(),
            memory_bytes: process.memory(),
        })
        .collect();
    match sort {
        ProcessSort::Cpu => processes.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent)),
        ProcessSort::Memory => {
            processes.sort_by_key(|process| std::cmp::Reverse(process.memory_bytes));
        }
    }
    processes.truncate(process_count.min(MAX_PROCESSES));

    let disks = Disks::new_with_refreshed_list()
        .map(|disks| {
            disks
                .iter()
                .map(|disk| DiskStats {
                    mount_point: disk.mount_point().display().to_string(),
                    total_bytes: disk.total_space(),
                    free_bytes: disk.available_space(),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(SystemStats {
        cpu_percent: system.global_cpu_usage(),
        memory_used_bytes: system.used_memory(),
        memory_total_bytes: system.total_memory(),
        disks,
        processes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_this_machine() {
        let stats = sample(ProcessSort::Memory, 3).expect("sample");
        assert!(stats.memory_total_bytes > 0);
        assert!(stats.memory_used_bytes <= stats.memory_total_bytes);
        assert!(stats.processes.len() <= 3);
    }
}
