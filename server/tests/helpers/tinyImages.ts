// server/tests/helpers/tinyImages.ts — real, decodable 2×2 images for route tests
// that only need "a valid image of type X".
//
// P7 B3: every uploaded raster image is walked and its metadata removed before it
// is stored (lib/imageMetadata.ts), and a container that cannot be walked is
// refused with 422. Fixtures made of magic bytes plus padding — enough for the
// old magic-byte check — are therefore (correctly) refused now. These are real
// files: each decodes with sharp and passes the metadata walker unchanged.
//
// No imports on purpose: suites that mock `sharp` or `fs` can use them.

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQI12M4IWcDRAwQCgAh9gSJ1exUdAAAAABJRU5ErkJggg==',
  'base64',
);

export const TINY_JPEG = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAaEAACAwEBAAAAAAAAAAAAAAABAgADBAUS/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABkRAAIDAQAAAAAAAAAAAAAAAAABAgMycf/aAAwDAQACEQMRAD8ArOLlzvxMDPRUzNmrJJQEk+RERDp6YTZt9P/Z',
  'base64',
);

export const TINY_GIF = Buffer.from('R0lGODlhAgACAIAAAExpccgePCH5BAUAAAAALAAAAAACAAIAAAICjFMAOw==', 'base64');

export const TINY_WEBP = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQjyKXp/+BiOh/AAA=', 'base64');
