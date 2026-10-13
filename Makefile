AWS_REGION ?= eu-west-1
STACK_NAME ?= TrafficMonitor

.PHONY: install test synth diff deploy update-hosting classify-bots public-stats compact-logs set-secrets set-abuseipdb-key outputs

install:
	npm ci

test:
	npm test -- --runInBand

synth:
	AWS_REGION=$(AWS_REGION) npm run synth -- --quiet

diff:
	AWS_REGION=$(AWS_REGION) npm run diff

deploy: test
	AWS_REGION=$(AWS_REGION) npm run deploy
	@$(MAKE) --no-print-directory update-hosting
	@$(MAKE) --no-print-directory classify-bots
	@$(MAKE) --no-print-directory public-stats

# Refresh the hosting network list now (it also runs weekly). A failure keeps the last copy.
update-hosting:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='HostingListFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --cli-read-timeout 90 /dev/stdout --query FunctionError --output text \
		|| echo "Hosting list update failed; the dashboard keeps the last copy."

# Judge bots now for the last DAYS full days (default 3; it also runs daily at 00:30 UTC).
# Runs in the background; the dashboard shows when it finishes.
DAYS ?= 3
classify-bots:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='BotClassifierFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --invocation-type Event \
		--cli-binary-format raw-in-base64-out --payload '{"days":$(DAYS)}' /dev/null --query StatusCode --output text \
		|| echo "Could not start the bot classifier."

# Refresh the public statistics files now (stats/*.json; they also refresh on a schedule).
public-stats:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='PublicStatsFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --cli-read-timeout 300 /dev/stdout --query FunctionError --output text \
		|| echo "Public statistics update failed; the last files stay in place."

# Merge log files now (it also runs daily at 01:30 UTC, for days the bot check has finished with).
# FROM/TO (YYYY-MM-DD) merge older days once; DRY=1 only reports what would be merged and dropped;
# UNJUDGED=1 also merges days without bot verdicts (from before the bot check), dropping agent bots only.
comma := ,

compact-logs:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='LogMergeFunctionName'].OutputValue" --output text) && \
	payload='{$(if $(FROM),"from":"$(FROM)"$(comma)"to":"$(TO)"$(comma))$(if $(UNJUDGED),"unjudged":"agents"$(comma))"dryRun":$(if $(DRY),true,false)}' && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --cli-read-timeout 900 \
		--cli-binary-format raw-in-base64-out --payload "$$payload" /dev/stdout --query FunctionError --output text

set-secrets:
	AWS_REGION=$(AWS_REGION) scripts/set-secrets.sh

set-abuseipdb-key:
	AWS_REGION=$(AWS_REGION) scripts/set-abuseipdb-key.sh

outputs:
	aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
