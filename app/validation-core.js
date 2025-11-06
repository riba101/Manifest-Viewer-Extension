(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.ManifestValidation = factory();
  }
})(typeof self !== 'undefined' ? self : this, () => {
  function createEmptyResult() {
    return { errors: [], warnings: [], info: [], mediaPlaylists: [] };
  }

  function normalizeNewlines(str) {
    return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function resolveUrl(uri, baseUrl) {
    if (!uri) return '';
    try {
      return new URL(uri, baseUrl || undefined).href;
    } catch {
      return uri;
    }
  }

  function isComment(line) {
    return /^#/i.test(line.trim());
  }

  function parseAttributeList(raw) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=("([^"]*)"|[^",\s][^,]*)/gi;
    let match;
    while ((match = regex.exec(raw))) {
      const key = match[1];
      const value = match[3] !== undefined ? match[3] : match[2];
      attrs[key] = value;
    }
    return attrs;
  }

  async function validateHlsManifest(manifest, options = {}) {
    const {
      baseUrl = '',
      fetchPlaylist = null,
      playlistType = 'auto',
      visited = new Set(),
    } = options;

    const result = createEmptyResult();
    if (!manifest || !manifest.trim()) {
      result.errors.push({ message: 'Manifest is empty.', line: null });
      return result;
    }

    const lines = normalizeNewlines(manifest).split('\n');
    const firstLine = (lines[0] || '').trim().toUpperCase();
    if (firstLine !== '#EXTM3U') {
      result.errors.push({ message: 'First line must be #EXTM3U.', line: 1 });
    }

    let pendingDirective = null;
    let mediaSegments = 0;
    let versionSeen = false;
    const variantEntries = [];
    const mediaPlaylistUris = [];
    let encounteredStreamInf = 0;

    lines.forEach((raw, index) => {
      const lineNumber = index + 1;
      const line = raw.trim();
      if (!line) return;

      if (isComment(line)) {
        if (pendingDirective && pendingDirective.type === 'segment') {
          // Keep waiting for the next URI
        } else if (pendingDirective) {
          const label = pendingDirective.type === 'variant' ? 'playlist URI' : 'segment URI';
          result.errors.push({
            message: `Expected ${label} after directive on line ${pendingDirective.line}.`,
            line: pendingDirective.line,
          });
          pendingDirective = null;
        }

        if (line.startsWith('#EXTINF')) {
          pendingDirective = { type: 'segment', line: lineNumber };
          const commaIndex = line.indexOf(',');
          if (commaIndex === -1) {
            result.warnings.push({
              message: '#EXTINF should include a comma separating duration and title.',
              line: lineNumber,
            });
          } else {
            const durationPart = line.slice('#EXTINF:'.length, commaIndex).trim();
            const duration = Number.parseFloat(durationPart);
            if (!Number.isFinite(duration) || duration < 0) {
              result.warnings.push({ message: '#EXTINF duration is not a valid number.', line: lineNumber });
            }
          }
        } else if (line.startsWith('#EXT-X-STREAM-INF')) {
          encounteredStreamInf += 1;
          pendingDirective = { type: 'variant', line: lineNumber };
          if (!/BANDWIDTH=/i.test(line)) {
            result.warnings.push({
              message: '#EXT-X-STREAM-INF is missing the BANDWIDTH attribute.',
              line: lineNumber,
            });
          }
        } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
          encounteredStreamInf += 1;
          const attrs = parseAttributeList(line);
          if (attrs && attrs.URI) variantEntries.push({ uri: attrs.URI, line: lineNumber });
          if (!attrs || !attrs.BANDWIDTH) {
            result.warnings.push({
              message: '#EXT-X-I-FRAME-STREAM-INF is missing the BANDWIDTH attribute.',
              line: lineNumber,
            });
          }
        } else if (line.startsWith('#EXT-X-MEDIA')) {
          const attrs = parseAttributeList(line);
          if (attrs && attrs.URI) mediaPlaylistUris.push({ uri: attrs.URI, line: lineNumber });
        } else if (line.startsWith('#EXT-X-VERSION')) {
          versionSeen = true;
          const value = line.split(':')[1];
          const parsed = Number.parseInt((value || '').trim(), 10);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            result.errors.push({ message: '#EXT-X-VERSION must be a positive integer.', line: lineNumber });
          }
        } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
          const value = line.split(':')[1];
          const parsed = Number.parseInt((value || '').trim(), 10);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            result.errors.push({ message: '#EXT-X-TARGETDURATION must be a positive integer.', line: lineNumber });
          }
        }
        return;
      }

      if (pendingDirective) {
        if (pendingDirective.type === 'segment') {
          mediaSegments += 1;
        } else if (pendingDirective.type === 'variant') {
          variantEntries.push({ uri: line, line: pendingDirective.line });
        }
        pendingDirective = null;
      }
    });

    if (pendingDirective) {
      const label = pendingDirective.type === 'variant' ? 'playlist URI' : 'segment URI';
      result.errors.push({
        message: `Expected ${label} after directive on line ${pendingDirective.line}.`,
        line: pendingDirective.line,
      });
    }

    if (!versionSeen) {
      result.warnings.push({ message: 'Manifest is missing #EXT-X-VERSION tag.', line: null });
    }
    const hasEndlist = lines.some((line) => line.trim().toUpperCase() === '#EXT-X-ENDLIST');

    const inferredType =
      playlistType === 'master' || playlistType === 'media'
        ? playlistType
        : encounteredStreamInf > 0 || mediaPlaylistUris.length > 0
        ? 'master'
        : 'media';

    if (inferredType === 'media') {
      if (!hasEndlist) {
        result.warnings.push({
          message: 'Media playlist does not include #EXT-X-ENDLIST (likely a live playlist).',
          line: null,
        });
      }
      if (mediaSegments === 0) {
        result.errors.push({ message: 'Media playlist is missing #EXTINF segments.', line: null });
      }
      result.info.push({
        message: `Media segments: ${mediaSegments}`,
        line: null,
      });
      return result;
    }

    // Master playlist validation
    const combinedVariants = [...variantEntries, ...mediaPlaylistUris];
    if (!combinedVariants.length) {
      result.errors.push({ message: 'Master playlist does not reference any child playlists.', line: null });
    } else {
      result.info.push({
        message: `Detected ${combinedVariants.length} referenced child playlist${combinedVariants.length === 1 ? '' : 's'}.`,
        line: null,
      });
    }

    const fetcher = typeof fetchPlaylist === 'function' ? fetchPlaylist : null;
    if (!fetcher) {
      result.warnings.push({
        message: 'Child playlists were not validated (no fetcher provided).',
        line: null,
      });
      return result;
    }

    const uniqueTargets = [];
    const seenTargets = new Set();
    combinedVariants.forEach(({ uri }) => {
      const resolved = resolveUrl(uri, baseUrl);
      if (!resolved) return;
      if (seenTargets.has(resolved)) return;
      seenTargets.add(resolved);
      uniqueTargets.push(resolved);
    });

    for (let i = 0; i < uniqueTargets.length; i += 1) {
      const target = uniqueTargets[i];
      if (visited.has(target)) {
        result.info.push({ message: `Skipped already validated playlist ${target}.`, line: null });
        continue;
      }
      visited.add(target);
      try {
        const childText = await fetcher(target);
        if (typeof childText !== 'string' || !childText.trim()) {
          result.errors.push({ message: `Playlist ${target} returned empty content.`, line: null });
          continue;
        }
        const childResult = await validateHlsManifest(childText, {
          baseUrl: target,
          fetchPlaylist,
          playlistType: 'media',
          visited,
        });
        result.mediaPlaylists.push({ uri: target, result: childResult });
        if (childResult.errors.length) {
          result.errors.push({
            message: `Child playlist ${target} has ${childResult.errors.length} error${childResult.errors.length === 1 ? '' : 's'}.`,
            line: null,
          });
        }
        if (childResult.warnings.length) {
          result.warnings.push({
            message: `Child playlist ${target} has ${childResult.warnings.length} warning${childResult.warnings.length === 1 ? '' : 's'}.`,
            line: null,
          });
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        result.errors.push({ message: `Failed to fetch child playlist ${target}: ${msg}`, line: null });
      }
    }

    return result;
  }

  function findChildByLocalName(node, localName) {
    if (!node || !node.children) return null;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      if (child.localName === localName) return child;
    }
    return null;
  }

  function findSegmentInfoForRepresentation(representation) {
    let current = representation;
    while (current) {
      const template = findChildByLocalName(current, 'SegmentTemplate');
      if (template) return { type: 'template', element: template };
      const list = findChildByLocalName(current, 'SegmentList');
      if (list) return { type: 'list', element: list };
      const base = findChildByLocalName(current, 'SegmentBase');
      if (base) return { type: 'base', element: base };
      current = current.parentElement;
    }
    return null;
  }

  function describeAdaptation(adaptation, index) {
    const parts = [];
    const contentType = adaptation.getAttribute('contentType');
    if (contentType) parts.push(contentType);
    const mimeType = adaptation.getAttribute('mimeType');
    if (mimeType && !parts.includes(mimeType)) parts.push(mimeType);
    const lang = adaptation.getAttribute('lang');
    if (lang) parts.push(`lang=${lang}`);
    parts.push(`#${index + 1}`);
    return parts.join(' · ');
  }

  function validateDashManifest(manifest) {
    const result = createEmptyResult();
    if (!manifest || !manifest.trim()) {
      result.errors.push({ message: 'Manifest is empty.', line: null });
      return result;
    }
    if (typeof DOMParser === 'undefined') {
      result.errors.push({ message: 'DOMParser is unavailable in this environment.', line: null });
      return result;
    }

    let doc;
    try {
      doc = new DOMParser().parseFromString(manifest, 'application/xml');
    } catch (e) {
      result.errors.push({ message: `Failed to parse XML: ${e?.message || String(e)}`, line: null });
      return result;
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) {
      result.errors.push({ message: 'Manifest contains XML syntax errors.', line: null });
      return result;
    }

    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') {
      result.errors.push({ message: 'Root element must be <MPD>.', line: null });
      return result;
    }

    const periods = Array.from(mpd.getElementsByTagNameNS('*', 'Period'));
    if (!periods.length) {
      result.errors.push({ message: 'MPD must contain at least one <Period>.', line: null });
    }

    let adaptationCount = 0;
    let representationCount = 0;
    let templatesWithTimeline = 0;

    periods.forEach((period, periodIndex) => {
      const adaptations = Array.from(period.getElementsByTagNameNS('*', 'AdaptationSet'));
      adaptationCount += adaptations.length;
      if (!adaptations.length) {
        result.errors.push({
          message: `Period ${periodIndex + 1} has no AdaptationSet elements.`,
          line: null,
        });
      }

      adaptations.forEach((adaptation, adaptationIndex) => {
        const representations = Array.from(adaptation.getElementsByTagNameNS('*', 'Representation'));
        if (!representations.length) {
          result.errors.push({
            message: `AdaptationSet ${describeAdaptation(adaptation, adaptationIndex)} has no Representation elements.`,
            line: null,
          });
        }

        representations.forEach((representation, representationIndex) => {
          representationCount += 1;
          const repLabel =
            representation.getAttribute('id') ||
            `${periodIndex + 1}:${adaptationIndex + 1}:${representationIndex + 1}`;
          const segmentInfo = findSegmentInfoForRepresentation(representation);
          if (!segmentInfo) {
            result.errors.push({
              message: `Representation ${repLabel} is missing SegmentTemplate/SegmentList/SegmentBase.`,
              line: null,
            });
            return;
          }

          if (segmentInfo.type === 'template') {
            const templateEl = segmentInfo.element;
            if (!templateEl.getAttribute('media')) {
              result.errors.push({
                message: `SegmentTemplate for representation ${repLabel} requires a @media attribute.`,
                line: null,
              });
            }
            const timeline = findChildByLocalName(templateEl, 'SegmentTimeline');
            if (timeline) {
              templatesWithTimeline += 1;
              const segments = timeline.getElementsByTagNameNS('*', 'S');
              if (!segments.length) {
                result.errors.push({
                  message: `SegmentTemplate for representation ${repLabel} has an empty SegmentTimeline.`,
                  line: null,
                });
              }
            } else if (!templateEl.hasAttribute('duration')) {
              result.warnings.push({
                message: `SegmentTemplate for representation ${repLabel} should define @duration when SegmentTimeline is absent.`,
                line: null,
              });
            }
          } else if (segmentInfo.type === 'list') {
            const segmentUrls = segmentInfo.element.getElementsByTagNameNS('*', 'SegmentURL');
            if (!segmentUrls.length) {
              result.errors.push({
                message: `SegmentList for representation ${repLabel} does not contain any SegmentURL entries.`,
                line: null,
              });
            }
          }
        });
      });
    });

    if (!representationCount) {
      result.errors.push({ message: 'MPD must contain at least one Representation.', line: null });
    }

    const mpdType = (mpd.getAttribute('type') || 'static').toLowerCase();
    if (mpdType === 'static') {
      const duration = mpd.getAttribute('mediaPresentationDuration') || mpd.getAttribute('duration');
      if (!duration) {
        result.warnings.push({
          message: 'Static MPD is missing @mediaPresentationDuration.',
          line: null,
        });
      }
    }

    result.info.push({
      message: `Periods: ${periods.length}, AdaptationSets: ${adaptationCount}, Representations: ${representationCount}`,
      line: null,
    });
    result.info.push({
      message: `SegmentTemplate timelines: ${templatesWithTimeline}`,
      line: null,
    });

    return result;
  }

  return {
    validateHlsManifest,
    validateDashManifest,
  };
});
