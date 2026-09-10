# TFECO-12827 AlloyDB Investigation

## Status

The remaining issue is reproduced and is waiting for clarification from the
Google AlloyDB service team.

The original ticket combines several issues. The CPU-count problem and the
old restriction on zonal primary instances are no longer the active problem.
The current issue is a permanent Terraform diff for `gce_zone`.

## Confirmed Reproduction

The issue was reproduced on September 10, 2026 using:

- `GoogleCloudPlatform/alloy-db/google` module `v8.3.0`
- A locally built `terraform-provider-google` binary through a Terraform dev override
- Project `hc-terraform-testing`
- Region `us-central1`
- A primary instance configured as `ZONAL`
- A one-node read pool

The reproduction configuration was:

```text
/Users/tavasya/go/src/github.com/hashicorp/terraform-provider-google/examples/alloydb-reproduction/main.tf
```

All test resources were destroyed after the test.

### Primary instance

Terraform configured:

```hcl
availability_type = "ZONAL"
gce_zone          = "us-central1-a"
machine_cpu_count = 2
```

The primary instance was created successfully. Google returned:

```yaml
availabilityType: ZONAL
machineConfig:
  cpuCount: 2
state: READY
```

The response did not contain `gceZone`.

### Read pool

Terraform configured:

```hcl
node_count        = 1
machine_cpu_count = 8
```

The read-pool instance was created successfully. Google returned:

```yaml
machineConfig:
  cpuCount: 8
readPoolConfig:
  nodeCount: 1
state: READY
```

This confirms that the old report saying the read-pool CPU count is always 4
does not reproduce with the current module.

### Permanent diff

After both instances were created, the next Terraform plan proposed:

```text
module.alloydb.google_alloydb_instance.primary will be updated in-place
+ gce_zone = "us-central1-a"
```

The API accepted the original zonal configuration, but the read response did
not return `gceZone`. Terraform therefore compared:

```text
Configuration: us-central1-a
API response:  empty
```

The same update would be proposed again after apply. This is a permanent diff.

## What Is Resolved

- The read-pool CPU count is passed through correctly by the current module.
- The old error stating that primary instances cannot be zonal is not current
  behavior. A zonal primary was created successfully.
- Module example fixes were merged in the upstream module in PRs
  [#43](https://github.com/GoogleCloudPlatform/terraform-google-alloy-db/pull/43)
  and [#45](https://github.com/GoogleCloudPlatform/terraform-google-alloy-db/pull/45).
- Later module changes removed unsupported read-pool `availability_type` and
  `gce_zone` inputs. Read-pool placement is service-managed: a one-node pool
  is zonal and a pool with multiple nodes is regional.

## Remaining Issue

The current provider sends `gceZone` correctly, but the AlloyDB API does not
return it in the subsequent instance response for the zonal primary.

The provider cannot safely infer the correct state value without knowing the
API contract. The missing field could mean:

- The API stores the requested zone but fails to return it.
- The field is intentionally create-only.
- The effective zone is represented by another field.
- The instance can move zones during failover, maintenance, or auto-healing.

Using another field such as `writableNode.zoneId` without confirmation could
make Terraform report an effective runtime zone as the requested placement,
even if those concepts are not equivalent.

## Previous Worker Attempt

The previous worker was Vaibhav. His attempt is
[GoogleCloudPlatform/terraform-google-alloy-db PR #195](https://github.com/GoogleCloudPlatform/terraform-google-alloy-db/pull/195).

It adds:

```hcl
lifecycle {
  ignore_changes = [instance_type, gce_zone]
}
```

This suppresses the repeated diff, but it is a workaround rather than a root
fix. It also causes future intentional changes to `gce_zone` to be ignored.
The PR is open and unmerged, and its integration check requires action.

## Related Issues

- [Terraform provider #13378](https://github.com/hashicorp/terraform-provider-google/issues/13378)
  is the original provider report for repeated AlloyDB updates involving
  `availability_type` and `gce_zone`. It remains open and is labeled as an
  upstream service issue.
- [Terraform provider #14944](https://github.com/hashicorp/terraform-provider-google/issues/14944)
  is a broader and more recent AlloyDB drift report. Its May 2026 comment
  confirms the same `gce_zone` behavior with current provider/module versions.
- [Terraform provider #23383](https://github.com/hashicorp/terraform-provider-google/issues/23383)
  concerned read-pool machine configuration behavior and was later resolved.
- [Terraform provider #29129](https://github.com/hashicorp/terraform-provider-google/issues/29129)
  is a separate enhancement for read-pool autoscaling. It references #13378
  and #14944 as examples of drift risks, but does not fix or replace them.

## Question Sent to Google

> Hey all, I’m currently investigating an AlloyDB issue involving the
> `gceZone` field missing from the API response.
>
> We configure a primary instance with `availabilityType = ZONAL` and
> `gceZone = us-central1-a`. The instance is created successfully, but a
> subsequent GET response includes `availabilityType: ZONAL` and omits
> `gceZone`.
>
> This causes Terraform to detect a permanent diff and propose the same
> `gce_zone` update on every plan.
>
> Is the omission of `gceZone` from the response expected behavior? If not,
> is there an existing fix or an estimated timeline for correcting it?

## Next Steps

1. Wait for the Google AlloyDB team to confirm whether omitting `gceZone` is
   expected or a service bug.
2. If it is a service bug, add the Google internal bug reference and ETA to
   TFECO-12827 and keep the issue blocked on the service fix.
3. If omission is expected, ask the provider team whether the field should be
   preserved from configuration, derived from another authoritative response
   field, or treated as create-only.
4. Treat PR #195 only as a possible workaround, not as a complete fix, until
   the API contract is clarified.
5. Update TFECO-12827 to state that the CPU-count issue and old zonal-primary
   restriction are resolved, leaving only the `gce_zone` permanent diff.
