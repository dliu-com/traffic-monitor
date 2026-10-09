#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { TrafficMonitorStack } from '../lib/traffic-monitor-stack';
import sites from '../config/sites.json';

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
// Exports are imported by the site stacks, which all live in eu-west-1.
if (region !== 'eu-west-1') throw new Error('TrafficMonitor must be deployed to eu-west-1, alongside the site stacks.');

const app = new App();
new TrafficMonitorStack(app, 'TrafficMonitor', {
  sites: sites.map((site) => site.key),
  tags: { service: 'traffic-monitor' },
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});
