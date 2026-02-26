// Configuration — auto-detect backend host from current page URL
(function () {
    const loc = window.location;
    const protocol = loc.protocol;                      // "http:" or "https:"
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    const host = loc.host;                              // "192.168.x.x:8000" or "example.com"

    window.CONFIG = {
        API_BASE_URL: `${protocol}//${host}/api`,
        WS_BASE_URL:  `${wsProtocol}//${host}/ws`,
        CODE_LENGTH:  6
    };
})();
