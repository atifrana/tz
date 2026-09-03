const BLOCKED_KEYWORDS = ['roblox'];

const blockedVideoIds = window.tizentubeBlockedVideoIds || new Set();
window.tizentubeBlockedVideoIds = blockedVideoIds;

let lastBlockedNavigationAt = 0;
let hasShownActiveToast = false;
let domFilterStarted = false;

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

function hideBlockedDomTiles() {
  const candidates = document.querySelectorAll([
    'ytlr-tile-renderer',
    'ytlr-compact-video-renderer',
    'ytlr-grid-video-renderer',
    'ytlr-lockup-view-model',
    '[is="ytlr-tile-renderer"]'
  ].join(','));

  for (const element of candidates) {
    if (!containsBlockedKeyword(element.textContent)) continue;
    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('visibility', 'hidden', 'important');
  }
}

function startBlockedTitleDomFilter() {
  if (domFilterStarted) return;
  domFilterStarted = true;

  setTimeout(() => {
    try {
      if (!hasShownActiveToast) {
        hasShownActiveToast = true;
        window.tizentubeShowToast?.('TizenTube Roblox Filter', 'Blocked-title filter active');
      }
    } catch (e) { }
  }, 2500);

  const runFilter = () => {
    try {
      hideBlockedDomTiles();
    } catch (e) {
      console.warn('Blocked title DOM filter failed:', e);
    }
  };

  setInterval(runFilter, 1000);

  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 250);

    const observer = new MutationObserver(runFilter);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    runFilter();
  };

  startObserver();
}

export {
  containsBlockedKeyword,
  filterBlockedTiles,
  handlePlaybackResponse,
  isBlockedVideoId,
  rememberBlockedVideoId,
  startBlockedTitleDomFilter,
  stopBlockedPlayback,
  textFromNode
};
