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
