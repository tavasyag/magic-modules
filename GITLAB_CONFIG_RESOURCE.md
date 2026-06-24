# Adding `google_cloudbuild_gitlab_config` Resource

This document outlines the steps to implement the `google_cloudbuild_gitlab_config` resource
in magic-modules (tracking issue #26660).

The `BitbucketServerConfig` resource is the primary reference — GitLab config follows the
same pattern with different API endpoints and field names.

---

## 1. Study the API

- API reference: `https://cloud.google.com/build/docs/api/reference/rest/v1/projects.locations.gitLabConfigs`
- Resource path: `projects/{project}/locations/{location}/gitLabConfigs/{id}`
- Operations: `create`, `get`, `patch`, `delete`, `list`

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Output only |
| `hostUri` | string | Optional — defaults to gitlab.com; required for GitLab Enterprise |
| `webhookKey` | string | Output only |
| `secrets` | object | Required — see sub-fields below |
| `secrets.personalAccessTokenVersionName` | string | Required |
| `secrets.readAccessTokenVersionName` | string | Required |
| `secrets.webhookSecretVersionName` | string | Required, immutable |
| `username` | string | Optional |
| `apiKey` | string | Optional, immutable |
| `connectedRepositories` | array | Optional — `projectNamespace` + `name` per entry |
| `sslCa` | string | Optional |

---

## 2. Create the Resource YAML

**File:** `mmv1/products/cloudbuild/GitLabConfig.yaml`

Model after `mmv1/products/cloudbuild/BitbucketServerConfig.yaml`. Key differences:

```yaml
name: GitLabConfig
base_url: projects/{{project}}/locations/{{location}}/gitLabConfigs
self_link: projects/{{project}}/locations/{{location}}/gitLabConfigs/{{config_id}}
create_url: projects/{{project}}/locations/{{location}}/gitLabConfigs?gitlabConfigId={{config_id}}
```

- `hostUri` is **optional** (not required), as it defaults to gitlab.com
- Secrets block uses `personalAccessTokenVersionName` instead of `adminAccessTokenVersionName`
- `connectedRepositories` items have `projectNamespace` + `name` (not `projectKey` + `repoSlug`)
- Custom code section should point to the four GitLab-specific templates (see step 3)

---

## 3. Create Custom Code Templates

The `connectedRepositories` field cannot be set directly via PATCH — it requires separate
API calls, just like `BitbucketServerConfig`. Four templates are needed:

### `mmv1/templates/terraform/encoders/cloudbuild_gitlab_config.go.tmpl`

Strip `connectedRepositories` from the create/update body so it isn't sent on the main request.

Reference: `encoders/cloudbuild_bitbucketserver_config.go.tmpl`

### `mmv1/templates/terraform/post_create/cloudbuild_gitlab_config.go.tmpl`

After the config is created, call `connectedRepositories:batchCreate` if any repos were specified.

Reference: `post_create/cloudbuild_bitbucketserver_config.go.tmpl`

Key URL difference:
```
.../gitLabConfigs/{{config_id}}/connectedRepositories:batchCreate
```

### `mmv1/templates/terraform/pre_update/cloudbuild_gitlab_config.go.tmpl`

Remove `connectedRepositories` from the `updateMask` and reconstruct the PATCH URL.

Reference: `pre_update/cloudbuild_bitbucketserver_config.go.tmpl`

Key URL difference:
```
.../gitLabConfigs/{{config_id}}
```

### `mmv1/templates/terraform/post_update/cloudbuild_gitlab_config.go.tmpl`

Diff old vs new `connectedRepositories`, remove stale repos and batch-create new ones.

Reference: `post_update/cloudbuild_bitbucketserver_config.go.tmpl`

Key API differences vs Bitbucket:
- Remove: `POST .../gitLabConfigs/{id}:removeGitLabConnectedRepository`
  with body `{"connectedRepository": {...}}`
- Batch create: `POST .../gitLabConfigs/{id}/connectedRepositories:batchCreate`

---

## 4. Create Sample Templates

**Directory:** `mmv1/templates/terraform/samples/services/cloudbuild/`

| File | Content |
|------|---------|
| `cloudbuild_gitlab_config.tf.tmpl` | Basic config (gitlab.com, no repos) |
| `cloudbuild_gitlab_config_repositories.tf.tmpl` | With `connected_repositories` |
| `cloudbuild_gitlab_config_enterprise.tf.tmpl` | With `host_uri`, `ssl_ca`, peered network |

Reference the corresponding Bitbucket samples for structure. The `samples` block in the YAML
references these files and controls which get turned into docs examples and tests.

---

## 5. Write Tests

Acceptance tests require real GitLab credentials. Per the issue, shared credentials will be
stored internally. Tests live either in:
- The `samples` block of the YAML (auto-generated), or
- `mmv1/third_party/terraform/services/cloudbuild/resource_cloudbuild_gitlab_config_test.go`

Test cases to cover:
1. Basic create, update, delete
2. Create with `connected_repositories`, then add/remove repos on update
3. GitLab Enterprise with `host_uri`, `ssl_ca`, and peered network

---

## 6. Verify Generation and Run Tests

Generate the provider output:

```bash
cd mmv1
go run . --output /path/to/terraform-provider-google --product products/cloudbuild
```

Run acceptance tests (requires credentials and `TF_ACC=1`):

```bash
cd /path/to/terraform-provider-google
TF_ACC=1 go test ./google/services/cloudbuild/... -run TestAccCloudbuildGitlabConfig -v -timeout 60m
```

---

## Reference Files

| Source (Bitbucket) | Target (GitLab) |
|--------------------|-----------------|
| `mmv1/products/cloudbuild/BitbucketServerConfig.yaml` | `mmv1/products/cloudbuild/GitLabConfig.yaml` |
| `encoders/cloudbuild_bitbucketserver_config.go.tmpl` | `encoders/cloudbuild_gitlab_config.go.tmpl` |
| `post_create/cloudbuild_bitbucketserver_config.go.tmpl` | `post_create/cloudbuild_gitlab_config.go.tmpl` |
| `pre_update/cloudbuild_bitbucketserver_config.go.tmpl` | `pre_update/cloudbuild_gitlab_config.go.tmpl` |
| `post_update/cloudbuild_bitbucketserver_config.go.tmpl` | `post_update/cloudbuild_gitlab_config.go.tmpl` |
| `samples/services/cloudbuild/cloudbuild_bitbucket_server_config*.tf.tmpl` | GitLab equivalents |
