/* SPDX-License-Identifier: GPL-2.0-only */
require('./runtime/object-cli.cjs').main(process.argv.slice(2), __dirname).catch(e=>{console.error(JSON.stringify({code:e.code||'INPUT',message:e.message}));process.exitCode=1;});
