# Sourced by the native acceptance scripts. Records WHERE a run failed: the stage, the
# exit status, and the exact failing command and line. It changes nothing about what
# passes: no assertion, timeout or retry is touched.
#
# Why: native run 40588847298 (Android, 8d71b881) exited 1 after its restart UI dump
# with no message at all. Several commands there fail silently under `set -e`
# (`grep -q`, a `uiautomator dump` whose output went to /dev/null, `screencap`), so the
# stage alone cannot name the culprit.
#
# Caller contract: keep `$stage` current; call acceptance_record_failure from the EXIT trap.
set -E
acceptance_failed_command=''
acceptance_failed_line=''
acceptance_failed_function=''
acceptance_detail=''
# A command failing inside a function is recorded with that function and line. A
# function that ends with `return 1` is recorded at its CALL site (bash raises ERR in the
# caller), so such functions set `acceptance_detail` before returning to say why.
trap 'acceptance_failed_command=$BASH_COMMAND; acceptance_failed_line=$LINENO; acceptance_failed_function=${FUNCNAME[0]:-main}' ERR

# $1 = exit status, $2 = evidence directory, $3 = label (android|ios)
acceptance_record_failure() {
  local status="$1" dir="$2" label="$3"
  (( status == 0 )) && return 0
  local cmd="${acceptance_failed_command//$'\n'/ }"
  cmd="${cmd:0:300}"
  printf 'NATIVE_%s_ACCEPTANCE_FAILED stage=%s exit=%s function=%s line=%s command=%s detail=%s\n' \
    "${label^^}" "${stage:-unknown}" "$status" "${acceptance_failed_function:-unknown}" \
    "${acceptance_failed_line:-unknown}" "${cmd:-unknown}" "${acceptance_detail:-none}" >&2
  printf 'stage=%s\nexit=%s\nfunction=%s\nline=%s\ncommand=%s\ndetail=%s\n' \
    "${stage:-unknown}" "$status" "${acceptance_failed_function:-unknown}" \
    "${acceptance_failed_line:-unknown}" "${cmd:-unknown}" "${acceptance_detail:-none}" > "$dir/native-failure-stage.txt"
}

# Why the next helpers exist: native run 40596429506 (Android, #530 on 3e1a4824) stopped at
# stage=first-ui-assertions with detail=NATIVE_SQLCIPHER_WRITE_PASS:redbox-or-runtime-not-ready,
# and the UI dump naming the error stayed in an artifact that cannot always be fetched. The
# job log itself now carries the screen text and the React Native error lines.
#
# Long opaque runs (hex/base64, 32+ chars) are masked so a stray secret cannot reach the log.
acceptance_redact() {
  sed -E 's/[A-Za-z0-9+\/_-]{32,}={0,2}/[redacted]/g'
}

# $1 = uiautomator XML dump, $2 = label (android). Prints at most 40 visible strings.
acceptance_print_ui_text() {
  local xml="$1" label="$2"
  [[ -f "$xml" ]] || { printf 'NATIVE_%s_UI_TEXT: (no dump at %s)\n' "${label^^}" "$xml" >&2; return 0; }
  { grep -oE '(text|content-desc)="[^"]+"' "$xml" || true; } \
    | sed -E 's/^(text|content-desc)="//; s/"$//; s/&quot;/"/g; s/&apos;/'"'"'/g; s/&lt;/</g; s/&gt;/>/g; s/&#10;/ /g; s/&amp;/\&/g' \
    | acceptance_redact | cut -c1-240 | awk 'NF && !seen[$0]++' | head -n 40 \
    | sed "s/^/NATIVE_${label^^}_UI_TEXT: /" >&2 || true
}

# Reads an `adb logcat -d` capture on stdin; prints the last 60 error lines from the JS
# runtime and fatal crashes only (not the whole log).
acceptance_print_runtime_errors() {
  local label="$1"
  { grep -E ' E (ReactNativeJS|ReactNative|AndroidRuntime|unknown:ReactNative)' || true; } \
    | acceptance_redact | cut -c1-300 | tail -n 60 \
    | sed "s/^/NATIVE_${label^^}_RUNTIME_ERROR: /" >&2 || true
}

# Classifies a uiautomator dump for an Android "<app> isn't responding" dialog.
# Run 40599501153 failed with the emulator's launcher ANR dialog in front of the app for
# all 90 dumps: a dialog of ANOTHER app blocked the observation, not the app under test.
# Prints exactly one line:
#   none                       no ANR dialog
#   own <title>                the app under test is not responding (a real failure)
#   foreign <x> <y> <title>    another app's dialog; (x, y) is the centre of its Wait button
# $1 = dump, $2 = label of the app under test. Always returns 0.
acceptance_classify_anr_dialog() {
  local xml="$1" own="$2" title node bounds
  title=$({ grep -oE "text=\"[^\"]* isn(&apos;|'|’)t responding\"" "$xml" 2>/dev/null || true; } | head -n 1 \
    | sed -E "s/^text=\"//; s/\"$//; s/&apos;/'/g; s/&amp;/\&/g")
  if [[ -z "$title" ]]; then echo none; return 0; fi
  if [[ "$title" == "$own isn"* ]]; then echo "own $title"; return 0; fi
  node=$({ grep -oE '<node [^>]*resource-id="android:id/aerr_wait"[^>]*>' "$xml" || true; } | head -n 1)
  bounds=$(printf '%s' "$node" | sed -nE 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/p')
  # A foreign dialog without a Wait button cannot be answered: report it as blocking.
  if [[ -z "$bounds" ]]; then echo "foreign - - $title"; return 0; fi
  read -r x1 y1 x2 y2 <<< "$bounds"
  echo "foreign $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 )) $title"
}

# Prints the last N lines of an evidence file to the job log (artifacts cannot always be
# downloaded). Used for the Metro log, whose bundling/serving errors would explain a
# redbox that appears before the bundle loads. $1 = file, $2 = label, $3 = tag, $4 = lines.
acceptance_print_tail() {
  local file="$1" label="$2" tag="$3" lines="${4:-40}"
  if [[ ! -f "$file" ]]; then printf 'NATIVE_%s_%s: (missing %s)\n' "${label^^}" "$tag" "$file" >&2; return 0; fi
  { tail -n "$lines" "$file" || true; } | acceptance_redact | cut -c1-300 \
    | sed "s/^/NATIVE_${label^^}_${tag}: /" >&2 || true
}

# ActivityManager logs "ANR in <process> (...)" for EVERY ANR, whether or not a dialog was
# shown or answered. Prints each ANR'd process once, from a logcat capture. Always 0.
acceptance_anr_processes() {
  { grep -oE 'ANR in [A-Za-z0-9._:]+' "$1" 2>/dev/null || true; } | sed 's/^ANR in //' | sort -u
}

# Reads an `adb logcat -d` capture on stdin; prints ActivityManager's ANR reports (which
# process, and WHY: e.g. "Reason: Input dispatching timed out ...", plus its load line).
# Runs 40599501153, 40607485747, 40607417756 and 40607482638 failed behind a launcher ANR
# dialog; these lines say whether that ANR was an input-dispatch timeout.
acceptance_print_anr_reports() {
  local label="$1"
  { grep -E ' ActivityManager: (ANR in |PID: |Reason: |Parent: |ErrorId: |Load: |Frozen: |CPU usage from |[0-9.]+% TOTAL)' || true; } \
    | acceptance_redact | cut -c1-300 | head -n 40 \
    | sed "s/^/NATIVE_${label^^}_ANR_REPORT: /" >&2 || true
}
