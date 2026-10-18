// Handlers for pages with a Content-Security-Policy. The policy does not allow
// inline event attributes (the click attribute, for example). An element names
// its action in a data attribute. The page registers the actions with registerActions():
//
//   <button data-click="startDistance" data-args="[7]">   click
//   <span data-dblclick="copyText" data-args='["x"]'>     double click
//   <select data-change="filterResults">                  change
//   <input data-blur="rename" data-args="[7]">            focus leaves the element
//   <input data-enter="stop">                             Enter key
//   <form data-submit="save">                             submit (the browser does not send the form)
//   <div class="modal" data-backdrop="close">             click on the element itself, not inside it
//
// `data-args` is a JSON list. The action gets these arguments, then the element,
// then the event. Only a registered name runs, so the page text cannot call any other function.
const pageActions = Object.create(null);

function registerActions(actions) {
    Object.assign(pageActions, actions);
}

function _runAction(name, element, event) {
    if (typeof name !== 'string' || typeof pageActions[name] !== 'function') return;
    let args = [];
    if (element.dataset.args) {
        try {
            const parsed = JSON.parse(element.dataset.args);
            args = Array.isArray(parsed) ? parsed : [parsed];
        } catch { return; }
    }
    try {
        const result = pageActions[name](...args, element, event);
        if (result && typeof result.catch === 'function') {
            result.catch(error => console.error('Action failed:', name, error));
        }
    } catch (error) {
        console.error('Action failed:', name, error);
    }
}

// Built-in action: go to another page of the application (for example `host.html`).
pageActions.navigate = page => {
    if (/^[a-z]+\.html$/.test(page)) location.href = page;
};

document.addEventListener('click', event => {
    const clicked = event.target.closest('[data-click]');
    if (clicked) _runAction(clicked.dataset.click, clicked, event);
    const backdrop = event.target.closest('[data-backdrop]');
    if (backdrop && event.target === backdrop) _runAction(backdrop.dataset.backdrop, backdrop, event);
});
document.addEventListener('dblclick', event => {
    const double = event.target.closest('[data-dblclick]');
    if (double) _runAction(double.dataset.dblclick, double, event);
});
document.addEventListener('change', event => {
    const changed = event.target.closest('[data-change]');
    if (changed) _runAction(changed.dataset.change, changed, event);
});
document.addEventListener('focusout', event => {
    const left = event.target.closest('[data-blur]');
    if (left) _runAction(left.dataset.blur, left, event);
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const entered = event.target.closest('[data-enter]');
    if (entered) _runAction(entered.dataset.enter, entered, event);
});
document.addEventListener('submit', event => {
    const form = event.target.closest('[data-submit]');
    if (!form) return;
    event.preventDefault();
    _runAction(form.dataset.submit, form, event);
});
