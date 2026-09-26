#!/usr/bin/env node
'use strict';

// Keep the server-local npm script as a compatibility entry point while using
// the repository's canonical, validated plugin builder. Having two independent
// transpilers previously let this path silently remove the provenance banner
// and bypass manifest/path/diagnostic checks.
require('../../scripts/build-plugins.js');
