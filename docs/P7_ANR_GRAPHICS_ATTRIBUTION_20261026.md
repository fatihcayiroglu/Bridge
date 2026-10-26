# Android #209: graphics operation attribution

This diagnostic child of draft #476 responds to a real failure, not a proposed
production workaround. Keep #209 and #321 open and #375 unmerged.

## Verified trigger

At `aaf1608abf5098205a34ad6a1afd67427d625bac`, Android run
[40316896743](https://github.com/fatihcayiroglu/Bridge/actions/runs/40316896743)
failed CS01, L01 and ANR01: 33 product PASS / 3 FAIL / 0 SKIP / 7 MEASURED.
The first input-dispatch FocusEvent ANR occurred during repeated cold starts.
L01 subsequently encountered the process dying after the error dialog; its
strict HOT-resume assertion correctly failed. CR00 and all nine EX01 phases
passed in this run. The previous preference and native-focus failures remain
unresolved; non-reproduction is not a fix.

The own-package ApplicationExitInfo probe found one available fatal ANR trace,
with complete **exit-history coverage** (15 retained records, capacity 16).
Its main-thread reduction was Native / running-code / framework-only /
graphics, topOperation=other, ownerOperation=none. The graphics hint identifies
`libhwui.so` in the bounded native stack. It does not identify a blocking
operation, establish a GPU/CPU cause, or prove the whole raw trace was read.
Raw ART traces were not retained and cannot be recovered from that finished
emulator. CPU pressure was observed but does not establish causality.

The conditional EX02 frozen-page control was NOT_APPLICABLE because EX01
passed; real CDP freeze/storage-control calibration is still outstanding.

## Change

Reuse the existing debug-only classifier, ActivityManager probe and strict Node
parser. Add fixed HardwareRenderer Java operation categories for initialization,
surface setup, buffer allocation and frame synchronization. Independently reduce
the first allowlisted demangled HWUI operation in each exact thread block.
RenderThread state, library hint and operation are appended to the **same exit
marker**, preventing cross-exit attribution. Native operations may be ancestors;
they are context, not a claim about the top blocked frame or ANR duration.

Only exact library basenames and allowlisted method boundaries are accepted;
unknown/mangled HWUI symbols remain `other`, missing threads remain `missing`.
Keep the existing 24 Java / 24 native frames per thread, 1 MiB trace read,
five trace markers, 200 parser lines, own-package exits and exact probe PID.
Preserve both historical marker formats without inventing absent fields.
Never export symbols, paths, arguments, raw frames, thread IDs or raw errors.
Release source sets, lifecycle behavior and every acceptance gate are unchanged.

Allowlisted methods were checked against AOSP `android-14.0.0_r1`:

- [HardwareRenderer.java](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/graphics/java/android/graphics/HardwareRenderer.java)
- [RenderProxy.cpp](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/renderthread/RenderProxy.cpp)
- [RenderThread.cpp](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/renderthread/RenderThread.cpp)
- [EglManager.cpp](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/renderthread/EglManager.cpp)
- [VulkanManager.cpp](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/renderthread/VulkanManager.cpp)
- [SkiaOpenGLPipeline.cpp](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/pipeline/skia/SkiaOpenGLPipeline.cpp)
- [SkiaVulkanPipeline.cpp](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/pipeline/skia/SkiaVulkanPipeline.cpp)
- [ThreadBase.h](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/libs/hwui/thread/ThreadBase.h)

## Validation and limits

Before the implementation, the new HardwareRenderer regression failed on the
unchanged classifier: 15 JVM tests, 1 failure (`renderer-init` expected, `other`
returned). Afterward, the real local JVM ran all 20 classifier tests successfully;
these are pure Java/JUnit tests, not Android platform acceptance. Synthetic ART
fixtures cover same-trace separation, wrong threads, spoofed symbols/libraries,
unknown operations, native scan boundaries and missing renderer context.
All 152 Android Node tests passed, 0 failed/skipped/todo, including historical
formats and fail-closed partial/private/foreign-PID graphics markers.

Exact-head Gradle, release compilation, mobile tests and real emulator journeys
must still run in CI. A run without a fatal ANR does not calibrate this graphics
diagnostic against a real ANR. Do not rerun merely to erase the first failure.
No production root cause or corrective lifecycle change is claimed here.
