export function firefoxProbeFailure(probe, expectedTranslation) {
  if (probe?.error) return probe.error;
  const status = probe?.status;
  if (status?.installed === false) {
    return status.reason || status.error || 'connectNative failed; treated as not installed';
  }
  if (status?.installed !== true || status.protocol !== 2) {
    return 'host-status did not report protocol 2; failover path remains available';
  }
  const text = probe.translate?.results?.fx1;
  if (typeof text !== 'string' || !text.trim() || Object.keys(probe.translate?.errors ?? {}).length > 0) {
    return 'native-host translate did not return a successful fx1 result';
  }
  if (expectedTranslation !== undefined && text !== expectedTranslation) {
    return 'native-host fx1 translation did not match the fixture';
  }
  return null;
}
