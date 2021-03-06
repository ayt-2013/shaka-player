/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.require('goog.asserts');
goog.require('shaka.Player');
goog.require('shaka.log');
goog.require('shaka.polyfill');
goog.require('shaka.util.Error');
goog.require('shaka.util.Platform');

// If ENABLE_DEBUG_LOADER is not set to false, goog.require() will try to load
// extra sources on-the-fly using pre-computed pathes in deps.js, which is not
// applicable for the tests.
goog['ENABLE_DEBUG_LOADER'] = false;

/**
 * Gets the value of an argument passed from karma.
 * @param {string} name
 * @return {?}
 */
function getClientArg(name) {
  if (window.__karma__ && __karma__.config.args.length) {
    return __karma__.config.args[0][name] || null;
  } else {
    return null;
  }
}

// Executed before test utilities and tests are loaded, but after Shaka Player
// is loaded in uncompiled mode.
(() => {
  // eslint-disable-next-line no-restricted-syntax
  const realAssert = console.assert.bind(console);

  /**
   * A version of assert() which hooks into jasmine and converts all failed
   * assertions into failed tests.
   * @param {*} condition
   * @param {string=} message
   */
  function jasmineAssert(condition, message) {
    realAssert(condition, message);
    if (!condition) {
      message = message || 'Assertion failed.';
      console.error(message);
      fail(message);
    }
  }
  goog.asserts.assert = jasmineAssert;
  console.assert = /** @type {?} */(jasmineAssert);

  /**
   * Patches a function on Element to fail an assertion if we use a namespaced
   * name on it.  We should use the namespace-aware versions instead.
   */
  function patchNamespaceFunction(type, name) {
    // eslint-disable-next-line no-restricted-syntax
    const real = type.prototype[name];
    /** @this {Element} */
    // eslint-disable-next-line no-restricted-syntax
    type.prototype[name] = function(arg) {
      // Ignore xml: namespaces since it's builtin.
      if (!arg.startsWith('xml:') && !arg.startsWith('xmlns:') &&
          arg.includes(':')) {
        fail('Use namespace-aware ' + name);
      }
      // eslint-disable-next-line no-restricted-syntax
      return real.apply(this, arguments);
    };
  }
  patchNamespaceFunction(Element, 'getAttribute');
  patchNamespaceFunction(Element, 'hasAttribute');
  patchNamespaceFunction(Element, 'getElementsByTagName');

  // As of Feb 2018, this is only implemented in Chrome.
  // https://developer.mozilla.org/en-US/docs/Web/Events/unhandledrejection
  window.addEventListener('unhandledrejection', (event) => {
    /** @type {?} */
    const error = event.reason;
    let message = 'Unhandled rejection in Promise: ' + error;

    // Shaka errors have the stack trace in their toString() already, so don't
    // add it again.  For native errors, we need to see where it came from.
    if (error && error.stack && !(error instanceof shaka.util.Error)) {
      message += '\n' + error.stack;
    }
    fail(message);
  });

  // Scrollbars ruin our screenshots on Safari.  In the past, we had applied
  // fixed offsets to the width to correct the scaling factor, but this was a
  // hack and inconsistent.  The best thing to do is completely disable
  // scrollbars through CSS.  This ensures that neither the inner iframe nor the
  // top-level window have scrollbars, which makes screenshots on Safari
  // consistent across versions.
  // Disable scrolling on the inner document, the execution context.
  const innerStyle = document.createElement('style');
  innerStyle.innerText = '::-webkit-scrollbar { display: none; }\n';
  innerStyle.innerText += 'body { overflow: hidden }\n';
  document.head.appendChild(innerStyle);
  // Disable scrolling on the outer document, the host context.
  const outerStyle = document.createElement('style');
  outerStyle.innerText = innerStyle.innerText;
  top.document.head.appendChild(outerStyle);

  // The spec filter callback occurs before calls to beforeAll, so we need to
  // install polyfills here to ensure that browser support is correctly
  // detected.
  shaka.polyfill.installAll();

  // Jasmine's clock mocks seem to interfere with Edge's Promise implementation.
  // This is only the case if Promises are first used after installing the mock.
  // As long as a then() callback on a Promise has happened once beforehand, it
  // seems to be OK.  I suspect Edge's Promise implementation is actually not in
  // native code, but rather something like a polyfill that binds to timer calls
  // the first time it needs to schedule something.
  Promise.resolve().then(() => {});

  const timeout = getClientArg('testTimeout');
  if (timeout) {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = Number(timeout);
  }

  const logLevel = getClientArg('logLevel');
  if (logLevel) {
    shaka.log.setLevel(Number(logLevel));
  } else {
    shaka.log.setLevel(shaka.log.Level.INFO);
  }

  /**
   * Returns a Jasmine callback which shims the real callback and checks for
   * a certain condition.  The test will only be run if the condition is true.
   *
   * @param {jasmine.Callback} callback  The test callback.
   * @param {function():*} cond
   * @param {?string} skipMessage  The message used when skipping a test; or
   *   null to not use pending().  This should only be null for before/after
   *   blocks.
   * @return {jasmine.Callback}
   */
  function filterShim(callback, cond, skipMessage) {
    return async () => {
      const val = await cond();
      if (!val) {
        if (skipMessage) {
          pending(skipMessage);
        }
        return;
      }

      if (callback.length) {
        // If this has a done callback, wrap in a Promise so we can await it.
        await new Promise((resolve) => callback(resolve));
      } else {
        // If this is an async test, this will wait for it to complete; if this
        // is a synchronous test, await will do nothing.
        await callback();
      }
    };
  }

  /**
   * Run a test that uses a DRM license server.
   *
   * @param {string} name
   * @param {jasmine.Callback} callback
   */
  window.drmIt = (name, callback) => {
    const shim = filterShim(
        callback, () => getClientArg('drm'),
        'Skipping tests that use a DRM license server.');
    it(name, shim);
  };

  /**
   * Run a test that has been quarantined.
   *
   * @param {string} name
   * @param {jasmine.Callback} callback
   */
  window.quarantinedIt = (name, callback) => {
    const shim = filterShim(
        callback, () => getClientArg('quarantined'),
        'Skipping tests that are quarantined.');
    it(name, shim);
  };

  /**
   * Run contained tests when the condition is true.
   *
   * @param {string} describeName  The name of the describe() block.
   * @param {function():*} cond A function for the condition; if this returns
   *   a truthy value, the tests will run, falsy will skip the tests.
   * @param {function()} describeBody The body of the describe() block.  This
   *   function will call before/after/it functions to define tests.
   */
  window.filterDescribe = (describeName, cond, describeBody) => {
    describe(describeName, () => {
      const old = {};
      for (const methodName of ['fit', 'it']) {
        old[methodName] = window[methodName];
        window[methodName] = (testName, testBody, ...rest) => {
          const shim = filterShim(
              testBody, cond, 'Skipping test due to platform support');
          return old[methodName](testName, shim, ...rest);
        };
      }
      const otherNames = ['afterAll', 'afterEach', 'beforeAll', 'beforeEach'];
      for (const methodName of otherNames) {
        old[methodName] = window[methodName];
        window[methodName] = (body, ...rest) => {
          const shim = filterShim(body, cond, null);
          return old[methodName](shim, ...rest);
        };
      }

      describeBody();

      for (const methodName in old) {
        window[methodName] = old[methodName];
      }
    });
  };

  /**
   * Unconditionally skip contained tests that would normally be run
   * conditionally.  Used to temporarily disable tests that use filterDescribe.
   * See filterDescribe above.
   *
   * @param {string} describeName
   * @param {function():*} cond
   * @param {function()} describeBody
   */
  window.xfilterDescribe = (describeName, cond, describeBody) => {
    const oldDescribe = window['describe'];
    window['describe'] = window['xdescribe'];
    filterDescribe(describeName, cond, describeBody);
    window['describe'] = oldDescribe;
  };

  beforeAll((done) => {  // eslint-disable-line no-restricted-syntax
    // Configure AMD modules and their dependencies.
    require.config({
      baseUrl: '/base/node_modules',
      packages: [
        {
          name: 'sprintf-js',
          main: 'src/sprintf',
        },
        {
          name: 'less',
          main: 'dist/less',
        },
        {
          name: 'fontfaceonload',
          main: 'dist/fontfaceonload',
        },
      ],
    });

    // Load required AMD modules, then proceed with tests.
    require(['sprintf-js', 'less', 'fontfaceonload'],
        (sprintfJs, less, FontFaceOnload) => {
          // These external interfaces are declared as "const" in the externs.
          // Avoid "const"-ness complaints from the compiler by assigning these
          // using bracket notation.
          window['sprintf'] = sprintfJs.sprintf;
          window['less'] = less;
          window['FontFaceOnload'] = FontFaceOnload;

          done();
        });
  });

  const originalSetTimeout = window.setTimeout;
  const delayTests = getClientArg('delayTests');
  if (delayTests) {
    afterEach((done) => {  // eslint-disable-line no-restricted-syntax
      console.log('Delaying test by ' + delayTests + ' seconds...');
      originalSetTimeout(done, delayTests * 1000);
    });
  }

  // Work-around: allow the Tizen media pipeline to cool down.
  // Without this, Tizen's pipeline seems to hang in subsequent tests.
  // TODO: file a bug on Tizen
  if (shaka.util.Platform.isTizen()) {
    afterEach((done) => {  // eslint-disable-line no-restricted-syntax
      originalSetTimeout(done, /* ms= */ 100);
    });
  }

  // Code in karma-jasmine's adapter will malform test failures when the
  // expectation message contains a stack trace, losing the failure message and
  // mixing up the stack trace of the failure.  To avoid this, we modify
  // shaka.util.Error not to create a stack trace.  This trace is not available
  // in production, and there is never any need for it in the tests.
  // Shimming shaka.util.Error proved too complicated because of a combination
  // of compiler restrictions and ES6 language features, so this is by far the
  // simpler answer.
  shaka.util.Error.createStack = false;
})();

// Shim Jasmine's execute function.  The karma-jasmine adapter will configure
// jasmine in a way that prevents us from setting our own specFilter config.
// There is no configuration that will stop karma-jasmine from doing this.
// So we hook into Jasmine's execute function (the last step of karma-jasmine's
// startup) to set our own config first.
// See also https://github.com/karma-runner/karma-jasmine/issues/273
/** @type {!jasmine.Env} */
const jasmineEnv = jasmine.getEnv();
// eslint-disable-next-line no-restricted-syntax
const originalJasmineExecute = jasmineEnv.execute.bind(jasmineEnv);
jasmineEnv.execute = () => {
  // Use a RegExp if --filter is set, else empty string will match all.
  const specFilterRegExp = new RegExp(getClientArg('filter') || '');
  const isBrowserSupported = shaka.Player.isBrowserSupported();

  /**
   * A filter over all Jasmine specs.
   * @param {jasmine.Spec} spec
   * @return {boolean}
   */
  function specFilter(spec) {
    // If the browser is not supported, don't run the tests.
    // If the user specified a RegExp, only run the matched tests.
    // Running zero tests is considered an error so the test run will fail on
    // unsupported browsers or if the filter doesn't match any specs.
    return isBrowserSupported && specFilterRegExp.test(spec.getFullName());
  }

  // Set jasmine config.
  const jasmineConfig = {
    specFilter,
    random: !!getClientArg('random'),
    seed: getClientArg('seed'),
  };

  jasmineEnv.configure(jasmineConfig);
  originalJasmineExecute();
};
