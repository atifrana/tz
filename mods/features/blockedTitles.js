const BLOCKED_KEYWORDS = ['roblox'];

const blockedVideoIds = window.tizentubeBlockedVideoIds || new Set();
window.tizentubeBlockedVideoIds = blockedVideoIds;

let lastBlockedNavigationAt = 0;
let hasShownActiveToast = false;

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
  return BLOCKED_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()));
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

function rendererContainsBlockedKeyword(renderer) {
  try {
    return containsBlockedKeyword(JSON.stringify(renderer));
  } catch (e) {
    return false;
  }
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
  'reelItemRenderer'
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
    serialized = JSON.stringify(payload);
  } catch (e) {
    return false;
  }

  if (!containsBlockedKeyword(serialized)) return false;
  if (!/"(watchEndpoint|videoId|contentId|reelWatchEndpoint)"/.test(serialized)) return false;

  const videoIdMatch = serialized.match(/"videoId"\s*:\s*"([^"]+)"/) || serialized.match(/"contentId"\s*:\s*"([^"]+)"/);
  rememberBlockedVideoId(videoIdMatch?.[1]);
  return true;
}

function filterBlockedVideoRenderersDeep(value, depth = 0, state = { visited: 0 }) {
  if (!value || typeof value !== 'object' || depth > 30 || state.visited > 5000) return;
  state.visited++;

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (isBlockedVideoLikeRenderer(value[i])) {
        value.splice(i, 1);
      } else {
        filterBlockedVideoRenderersDeep(value[i], depth + 1, state);
      }
    }
    return;
  }

  for (const key in value) {
    filterBlockedVideoRenderersDeep(value[key], depth + 1, state);
  }
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
  filterBlockedVideoRenderersDeep,
  filterBlockedTiles,
  handlePlaybackResponse,
  isBlockedVideoId,
  rememberBlockedVideoId,
  showBlockedTitleFilterToast,
  stopBlockedPlayback,
  textFromNode
};
