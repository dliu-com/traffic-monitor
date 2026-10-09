import { Construct } from 'constructs';
import { aws_logs as logs, Stack, StackProps } from 'aws-cdk-lib';
import { V2_PREFIX } from './traffic-monitor-stack';
import FIELDS from '../lambda/partitioner/fields.json';

// The CloudFront standard logging (v2) fields we ask for, in the order the partitioner writes them.
export const RECORD_FIELDS: string[] = [...FIELDS.legacy, ...FIELDS.added];

export interface TrafficLogDeliveryStackProps extends StackProps {
  /** Log bucket of the TrafficMonitor stack (eu-west-1). */
  logBucketName: string;
  /** Sites with the CloudFront distribution that serves them. */
  sites: { key: string; distributionId: string }[];
}

/**
 * Standard logging (v2) for each site's CloudFront distribution. CloudFront log deliveries
 * must be created in us-east-1; they write to the log bucket under raw-v2/<site>/YYYY/MM/DD/.
 */
export class TrafficLogDeliveryStack extends Stack {
  constructor(scope: Construct, id: string, props: TrafficLogDeliveryStackProps) {
    super(scope, id, props);
    if (props.env?.region && props.env.region !== 'us-east-1') {
      throw new Error('CloudFront log deliveries must be created in us-east-1.');
    }

    const destination = new logs.CfnDeliveryDestination(this, 'LogBucketDestination', {
      name: 'traffic-monitor-log-bucket',
      destinationResourceArn: `arn:aws:s3:::${props.logBucketName}/${V2_PREFIX}`,
      outputFormat: 'w3c',
    });

    for (const site of props.sites) {
      if (!/^[a-z0-9-]+$/.test(site.key) || !/^E[A-Z0-9]{5,20}$/.test(site.distributionId)) {
        throw new Error(`Invalid site ${site.key} / ${site.distributionId}`);
      }
      const source = new logs.CfnDeliverySource(this, `Source-${site.key}`, {
        name: `traffic-${site.key}`,
        resourceArn: `arn:aws:cloudfront::${this.account}:distribution/${site.distributionId}`,
        logType: 'ACCESS_LOGS',
      });
      const delivery = new logs.CfnDelivery(this, `Delivery-${site.key}`, {
        deliverySourceName: source.name,
        deliveryDestinationArn: destination.attrArn,
        recordFields: RECORD_FIELDS,
        fieldDelimiter: '\t',
        s3SuffixPath: `${site.key}/{yyyy}/{MM}/{dd}`,
        s3EnableHiveCompatiblePath: false,
      });
      delivery.addResourceDependency(source);
    }
  }
}
