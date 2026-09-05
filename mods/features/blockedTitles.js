import { configRead } from '../config.js';

const blockedVideoIds = window.tizentubeBlockedVideoIds || new Set();
window.tizentubeBlockedVideoIds = blockedVideoIds;

const rawJsonParse = JSON.parse;
const rawJsonStringify = JSON.stringify;

let lastBlockedNavigationAt = 0;
let hasShownActiveToast = false;
let lastFilteredToastAt = 0;
let totalFilteredRendererCount = 0;

function textFromNode(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) {
    return node.runs.map(run => run?.text || '').join('');
  }
  return '';
}

function containsBlockedKeyword(text) {
  const normalized = String(text || '').toLowerCase();
  return getBlockedTitleKeywords().some(keyword => normalized.includes(keyword));
}

function normalizeBlockedTitleKeywords(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const normalized = [];

  for (const keyword of source) {
    const text = String(keyword || '').trim().toLowerCase();
    if (!text || normalized.includes(text)) continue;
    normalized.push(text);
  }

  return normalized;
}

function getBlockedTitleKeywords() {
  try {
    return normalizeBlockedTitleKeywords(configRead('blockedTitleKeywords'));
  } catch (e) {
    return ['roblox'];
  }
}

function rememberBlockedVideoId(videoId) {
  if (videoId) blockedVideoIds.add(videoId);
}

function isBlockedVideoId(videoId) {
  return Boolean(videoId && blockedVideoIds.has(videoId));
}

function getTileTitle(item) {
  return textFromNode(item?.tileRenderer?.metadata?.tileMetadataRenderer?.title);
}

function getTileVideoId(item) {
  return item?.tileRenderer?.contentId || item?.tileRenderer?.onSelectCommand?.watchEndpoint?.videoId;
}

function safeStringify(value) {
  try {
    return rawJsonStringify(value);
  } catch (e) {
    return '';
  }
}

function rendererContainsBlockedKeyword(renderer) {
  return containsBlockedKeyword(safeStringify(renderer));
}

function isBlockedTile(item) {
  const title = getTileTitle(item);
  if (!containsBlockedKeyword(title) && !rendererContainsBlockedKeyword(item?.tileRenderer)) return false;

  rememberBlockedVideoId(getTileVideoId(item));
  return true;
}

function filterBlockedTiles(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(item => !isBlockedTile(item));
}

const VIDEO_RENDERER_KEYS = [
  'tileRenderer',
  'videoRenderer',
  'compactVideoRenderer',
  'gridVideoRenderer',
  'searchVideoRenderer',
  'lockupViewModel',
  'reelItemRenderer',
  'richItemRenderer',
  'playlistVideoRenderer',
  'playlistPanelVideoRenderer',
  'compactStationRenderer',
  'tvhtml5VideoRenderer'
];

function getVideoRendererPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  for (const key of VIDEO_RENDERER_KEYS) {
    if (value[key]) return value[key];
  }

  return null;
}

function isBlockedVideoLikeRenderer(value) {
  if (!value || typeof value !== 'object') return false;
  const payload = getVideoRendererPayload(value);
  if (!payload) return false;

  let serialized;
  try {
    serialized = safeStringify(payload);
  } catch (e) {
    return false;
  }

  if (!containsBlockedKeyword(serialized)) return false;
  if (!/"(watchEndpoint|videoId|contentId|reelWatchEndpoint)"/.test(serialized)) return false;

  const videoIdMatch = serialized.match(/"videoId"\s*:\s*"([^"]+)"/) || serialized.match(/"contentId"\s*:\s*"([^"]+)"/);
  rememberBlockedVideoId(videoIdMatch?.[1]);
  return true;
}

function showFilteredRendererToast(count) {
  if (count <= 0) return;
  totalFilteredRendererCount += count;

  const now = Date.now();
  if (now - lastFilteredToastAt < 1500) return;
  lastFilteredToastAt = now;

  try {
    window.tizentubeShowToast?.('TizenTube Roblox Filter', `Filtered ${totalFilteredRendererCount} blocked video${totalFilteredRendererCount === 1 ? '' : 's'}`);
  } catch (e) { }
}

function filterBlockedVideoRenderersDeep(value, depth = 0, state = { visited: 0, removed: 0 }) {
  if (!value || typeof value !== 'object' || depth > 40 || state.visited > 50000) {
    if (depth === 0) showFilteredRendererToast(state.removed);
    return state.removed;
  }
  state.visited++;

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (isBlockedVideoLikeRenderer(value[i])) {
        value.splice(i, 1);
        state.removed++;
      } else {
        filterBlockedVideoRenderersDeep(value[i], depth + 1, state);
      }
    }
    if (depth === 0) showFilteredRendererToast(state.removed);
    return state.removed;
  }

  for (const key in value) {
    filterBlockedVideoRenderersDeep(value[key], depth + 1, state);
  }

  if (depth === 0) showFilteredRendererToast(state.removed);
  return state.removed;
}

function filterBlockedResponseObject(response) {
  handlePlaybackResponse(response);
  return filterBlockedVideoRenderersDeep(response);
}

function filterBlockedResponseText(text) {
  if (!containsBlockedKeyword(text)) return null;

  let response;
  try {
    response = rawJsonParse(text);
  } catch (e) {
    return null;
  }

  const removed = filterBlockedResponseObject(response);
  if (removed <= 0) return null;

  try {
    return rawJsonStringify(response);
  } catch (e) {
    return null;
  }
}

function isYouTubeApiUrl(url) {
  return /(^|\/)(youtubei|youtubei\/v1|youtubei\/v1\/(browse|search|next|player))\b/.test(String(url || '')) ||
    /youtube\.com\/youtubei\/v1\/(browse|search|next|player)/.test(String(url || ''));
}

function cloneResponseWithText(response, text) {
  if (!window.Response) return response;

  try {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch (e) {
    return response;
  }
}

function patchFetchResponses() {
  if (!window.fetch || window.tizentubeBlockedTitleFetchPatched) return;
  window.tizentubeBlockedTitleFetchPatched = true;

  const originalFetch = window.fetch;
  window.fetch = function () {
    return originalFetch.apply(this, arguments).then(response => {
      const url = response?.url || arguments[0]?.url || arguments[0];
      if (!isYouTubeApiUrl(url)) return response;
      if (!response?.clone) return response;

      return response.clone().text().then(text => {
        const filteredText = filterBlockedResponseText(text);
        return filteredText ? cloneResponseWithText(response, filteredText) : response;
      }).catch(() => response);
    });
  };
}

function patchXhrResponses() {
  if (!window.XMLHttpRequest || window.tizentubeBlockedTitleXhrPatched) return;
  window.tizentubeBlockedTitleXhrPatched = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.tizentubeBlockedTitleUrl = url;
    return originalOpen.apply(this, arguments);
  };

  function applyFilteredXhrResponse(xhr) {
    if (xhr.tizentubeBlockedTitleFiltered) return;
    if (xhr.readyState !== 4) return;
    if (xhr.responseType && xhr.responseType !== 'text') return;

    xhr.tizentubeBlockedTitleFiltered = true;
    const filteredText = filterBlockedResponseText(xhr.responseText);
    if (!filteredText) return;

    try {
      Object.defineProperty(xhr, 'responseText', { value: filteredText });
      Object.defineProperty(xhr, 'response', { value: filteredText });
    } catch (e) { }
  }

  XMLHttpRequest.prototype.send = function () {
    if (isYouTubeApiUrl(this.tizentubeBlockedTitleUrl)) {
      const originalReadyStateChange = this.onreadystatechange;
      if (typeof originalReadyStateChange === 'function') {
        this.onreadystatechange = function () {
          applyFilteredXhrResponse(this);
          return originalReadyStateChange.apply(this, arguments);
        };
      }

      const originalLoad = this.onload;
      if (typeof originalLoad === 'function') {
        this.onload = function () {
          applyFilteredXhrResponse(this);
          return originalLoad.apply(this, arguments);
        };
      }

      this.addEventListener('readystatechange', () => {
        applyFilteredXhrResponse(this);
      });
    }

    return originalSend.apply(this, arguments);
  };
}

function patchBlockedTitleNetworkResponses() {
  patchFetchResponses();
  patchXhrResponses();
}

function getWatchMetadata(response) {
  const contents = response?.contents?.singleColumnWatchNextResults?.results?.results?.contents;
  if (!Array.isArray(contents)) return null;

  for (const section of contents) {
    const sectionContents = section?.itemSectionRenderer?.contents;
    if (!Array.isArray(sectionContents)) continue;

    for (const item of sectionContents) {
      if (item?.videoMetadataRenderer) return item.videoMetadataRenderer;
    }
  }

  return null;
}

function findBlockedPlayback(response) {
  const detailsTitle = response?.videoDetails?.title;
  if (containsBlockedKeyword(detailsTitle)) {
    return {
      videoId: response?.videoDetails?.videoId,
      title: detailsTitle
    };
  }

  const metadata = getWatchMetadata(response);
  const metadataTitle = textFromNode(metadata?.title);
  if (containsBlockedKeyword(metadataTitle)) {
    return {
      videoId: metadata?.videoId,
      title: metadataTitle
    };
  }

  return null;
}

function stopBlockedPlayback(title) {
  try {
    const video = document.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  } catch (e) {
    console.warn('Failed to stop blocked video playback:', e);
  }

  try {
    const subtitle = title ? `Blocked video: ${title}` : 'Blocked video';
    window.tizentubeShowToast?.('TizenTube', subtitle);
  } catch (e) {
    console.warn('Failed to show blocked video toast:', e);
  }

  const now = Date.now();
  if (now - lastBlockedNavigationAt < 3000) return;
  lastBlockedNavigationAt = now;

  setTimeout(() => {
    try {
      if (location.hash.indexOf('/watch') !== -1 && window.history.length > 1) {
        window.history.back();
      }
    } catch (e) {
      console.warn('Failed to navigate away from blocked video:', e);
    }
  }, 100);
}

function handlePlaybackResponse(response) {
  const blockedPlayback = findBlockedPlayback(response);
  if (!blockedPlayback) return false;

  rememberBlockedVideoId(blockedPlayback.videoId);
  response.streamingData = null;
  response.playabilityStatus = {
    status: 'ERROR',
    reason: 'Blocked by TizenTube'
  };
  setTimeout(() => stopBlockedPlayback(blockedPlayback.title), 0);
  return true;
}

function showBlockedTitleFilterToast() {
  setTimeout(() => {
    try {
      if (!hasShownActiveToast) {
        hasShownActiveToast = true;
        window.tizentubeShowToast?.('TizenTube Roblox Filter', 'Blocked-title filter active');
      }
    } catch (e) { }
  }, 2500);
}

export {
  containsBlockedKeyword,
  filterBlockedResponseObject,
  filterBlockedResponseText,
  filterBlockedVideoRenderersDeep,
  filterBlockedTiles,
  getBlockedTitleKeywords,
  handlePlaybackResponse,
  isBlockedVideoId,
  normalizeBlockedTitleKeywords,
  patchBlockedTitleNetworkResponses,
  rememberBlockedVideoId,
  showBlockedTitleFilterToast,
  stopBlockedPlayback,
  textFromNode
};
