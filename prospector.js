#!/usr/bin/env node
// SubDraw OpenAI Prospector — Entry Point
// Confirms startup then runs continuous search loop
console.log('===========================================');
console.log('🚀 SUBDRAW PROSPECTOR STARTING');
console.log('   Entry: prospector.js');
console.log('   Time:', new Date().toISOString());
console.log('   Node:', process.version);
console.log('===========================================');

require('./scripts/prospector-continuous');
