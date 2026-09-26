-- API keys carry scopes. `runtime` runs sessions; `admin` additionally changes tenant configuration
-- (auth policy, provider/BYOK config, agent definitions). Without this split a leaked runtime key could
-- switch the tenant back to header-asserted identity and then impersonate every user.
ALTER TABLE api_keys ADD COLUMN scopes JSON NULL;
