// Keep the files of the practice page on the device, so that the page opens
// without a connection. The service worker is in sw.js.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(error => { console.warn('Offline copy is not available:', error); });
    });
}
