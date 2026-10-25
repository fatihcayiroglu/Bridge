import { URL as NativeURL } from 'react-native-url-polyfill';
import { toASCII } from 'tr46';
import type {
  ProbeTransport,
  ServerOriginParts,
  ServerUrlOptions,
} from '@bridge/core';

/**
 * The mobile URL library omits full IDNA canonicalization. Use the maintained
 * UTS46 implementation with WHATWG URL's non-strict domain options. No parser,
 * Unicode mapping or encoding algorithm is reimplemented here.
 */
export function parseNativeServerUrl(input: string): ServerOriginParts {
  const url = new NativeURL(input);
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.hostname.startsWith('[')
  ) {
    const ascii = toASCII(url.hostname, {
      checkHyphens: false,
      checkBidi: true,
      checkJoiners: true,
      useSTD3ASCIIRules: false,
      transitionalProcessing: false,
      verifyDNSLength: false,
      ignoreInvalidPunycode: false,
    });
    if (ascii === null) throw new TypeError('Invalid server hostname');
    url.hostname = ascii;
  }
  return url;
}

export function nativeServerOptions(
  platform: string,
  development: boolean,
): ServerUrlOptions {
  return {
    parseUrl: parseNativeServerUrl,
    allowAndroidEmulatorLoopback: development && platform === 'android',
  };
}

export const nativeProbe: ProbeTransport = async (url, init) => {
  const response = await fetch(url, init);
  // Some native fetch implementations follow redirects internally despite the
  // requested policy. Never accept a liveness reply from a different target.
  if (response.url !== url || response.redirected) {
    throw new Error('Server response target could not be verified');
  }
  return response;
};
