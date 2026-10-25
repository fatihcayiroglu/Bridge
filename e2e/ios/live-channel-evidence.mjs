// Failure-only iOS acceptance diagnostics. Deliberately export counts and
// booleans; never serialize channel metadata, account IDs or auth material.
export function publicationApiFacts(response, expectedChannelId) {
  const facts = {
    apiStatus: Number.isInteger(response?.status) ? response.status : null,
    apiContainsChannel: null,
    apiChannelCount: null,
  };
  if (Array.isArray(response?.json)) {
    facts.apiContainsChannel = response.json.some(channel => channel?._id === expectedChannelId);
    facts.apiChannelCount = response.json.length;
  }
  return facts;
}

export function publicationViewFacts(value) {
  const bool = key => typeof value?.[key] === 'boolean' ? value[key] : null;
  return {
    webviewContainsChannel: bool('webviewContainsChannel'),
    webviewChannelCount: Number.isSafeInteger(value?.webviewChannelCount) && value.webviewChannelCount >= 0
      ? value.webviewChannelCount : null,
    selectedServer: bool('selectedServer'),
    webviewVisible: bool('webviewVisible'),
    browserOnline: bool('browserOnline'),
  };
}
