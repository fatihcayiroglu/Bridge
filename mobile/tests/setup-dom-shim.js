'use strict';

class BridgeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}
}

class BridgeEventTarget {
  constructor() {
    this._listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!listener) return;
    const list = this._listeners.get(type) || [];
    list.push(listener);
    this._listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type) || [];
    this._listeners.set(type, list.filter((l) => l !== listener));
  }

  dispatchEvent(event) {
    if (!event || !event.type) return true;
    event.target = event.target || this;
    const list = this._listeners.get(event.type) || [];
    for (const listener of list) listener.call(this, event);
    return !event.defaultPrevented;
  }
}

function createClassList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    contains: (item) => values.has(item),
    toString: () => Array.from(values).join(' '),
  };
}

function createElement(tagName) {
  const el = new BridgeEventTarget();
  el.tagName = String(tagName || '').toUpperCase();
  el.children = [];
  el.style = {
    setProperty(name, value) {
      this[name] = value;
    },
  };
  el.classList = createClassList();
  el.attributes = {};
  el.textContent = '';
  el.id = '';

  el.prepend = (...children) => {
    el.children.unshift(...children);
    children.forEach(registerElement);
  };

  el.appendChild = (child) => {
    el.children.push(child);
    registerElement(child);
    return child;
  };

  el.setAttribute = (name, value) => {
    el.attributes[name] = String(value);
    if (name === 'id') {
      el.id = String(value);
      registerElement(el);
    }
  };

  el.getAttribute = (name) => el.attributes[name];
  el.hasAttribute = (name) => Object.prototype.hasOwnProperty.call(el.attributes, name);
  el.closest = () => null;
  el.querySelector = () => null;
  el.remove = () => {};

  return el;
}

const elementsById = new Map();

function registerElement(el) {
  if (el && el.id) elementsById.set(el.id, el);
}

const document = new BridgeEventTarget();
document.documentElement = createElement('html');
document.body = createElement('body');
document.createElement = createElement;
document.getElementById = (id) => elementsById.get(id) || null;
document.querySelector = () => null;

const localStorageData = new Map();
const localStorage = {
  getItem: (key) => localStorageData.has(key) ? localStorageData.get(key) : null,
  setItem: (key, value) => localStorageData.set(key, String(value)),
  removeItem: (key) => localStorageData.delete(key),
  clear: () => localStorageData.clear(),
};

const window = new BridgeEventTarget();
window.document = document;
window.localStorage = localStorage;
window.location = { origin: 'http://localhost' };
window.navigator = { share: undefined };
window.matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

global.window = window;
global.document = document;
global.localStorage = localStorage;
global.navigator = window.navigator;
global.CustomEvent = BridgeEvent;
global.Event = BridgeEvent;
