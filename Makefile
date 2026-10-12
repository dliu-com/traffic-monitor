AWS_REGION ?= eu-west-1
STACK_NAME ?= TrafficMonitor

.PHONY: install test synth diff deploy update-hosting set-secrets outputs

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

# Refresh the hosting network list now (it also runs weekly). A failure keeps the last copy.
update-hosting:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='HostingListFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --cli-read-timeout 90 /dev/stdout --query FunctionError --output text \
		|| echo "Hosting list update failed; the dashboard keeps the last copy."

set-secrets:
	AWS_REGION=$(AWS_REGION) scripts/set-secrets.sh

outputs:
	aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
