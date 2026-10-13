#!/usr/bin/env node
import 'source-map-support/register';
import { readFileSync } from 'fs';
import { join } from 'path';
import { App, Tags } from 'aws-cdk-lib';
import { TrafficMonitorStack } from '../lib/traffic-monitor-stack';
import { TrafficLogDeliveryStack } from '../lib/log-delivery-stack';
import sites from '../config/sites.json';

// Distribution IDs are account-specific, so they live in a gitignored file next to sites.json.
const distributionsFile = join(__dirname, '..', 'config', 'distributions.local.json');
const distributions: Record<string, string> = JSON.parse(readFileSync(distributionsFile, 'utf8'));
for (const { key } of sites) {
  if (!distributions[key]) throw new Error(`config/distributions.local.json has no distribution ID for site "${key}".`);
}

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
// Exports are imported by the site stacks, which all live in eu-west-1.
if (region !== 'eu-west-1') throw new Error('TrafficMonitor must be deployed to eu-west-1, alongside the site stacks.');
const account = process.env.CDK_DEFAULT_ACCOUNT;
const app = new App();
// Tag both stacks and every taggable resource in them.
const tags = { service: 'traffic-monitor', Project: 'traffic.dliu.com' };
for (const [key, value] of Object.entries(tags)) Tags.of(app).add(key, value);
const monitor = new TrafficMonitorStack(app, 'TrafficMonitor', {
  sites: sites.map(({ key, host }) => ({ key, host })),
  env: { account, region },
  crossRegionReferences: true,
});

// CloudFront standard logging (v2) deliveries can only be created in us-east-1.
const delivery = new TrafficLogDeliveryStack(app, 'TrafficLogDelivery', {
  logBucketName: monitor.logBucket.bucketName,
  sites: sites.map(({ key }) => ({ key, distributionId: distributions[key] })),
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
});
delivery.addStackDependency(monitor);
