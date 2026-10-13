AWS_REGION ?= eu-west-1
STACK_NAME ?= TrafficMonitor

.PHONY: install test synth diff deploy update-hosting classify-bots set-secrets set-abuseipdb-key outputs

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

# Refresh the hosting network list now (it also runs weekly). A failure keeps the last copy.
update-hosting:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='HostingListFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --cli-read-timeout 90 /dev/stdout --query FunctionError --output text \
		|| echo "Hosting list update failed; the dashboard keeps the last copy."

# Judge bots now for the last DAYS full days (default 7; it also runs daily at 00:30 UTC), e.g. DAYS=365
# to backfill. Runs in the background; the dashboard shows when it finishes.
DAYS ?= 7
classify-bots:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='BotClassifierFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --invocation-type Event \
		--cli-binary-format raw-in-base64-out --payload '{"days":$(DAYS)}' /dev/null --query StatusCode --output text \
		|| echo "Could not start the bot classifier."

set-secrets:
	AWS_REGION=$(AWS_REGION) scripts/set-secrets.sh

set-abuseipdb-key:
	AWS_REGION=$(AWS_REGION) scripts/set-abuseipdb-key.sh

outputs:
	aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
