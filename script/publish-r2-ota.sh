#!/usr/bin/env bash

# Publish a generated OTA manifest and its archives to Cloudflare R2.
#
# The currently published manifest is treated as the fallback release. When
# all of its public asset URLs are healthy, versions older than that fallback
# are removed before upload so the bucket never needs three complete releases.
# After the new manifest is publicly visible, a final reconciliation keeps only
# the new release and the verified fallback.

set -euo pipefail

artifacts_dir=${1:-artifacts}
manifest_file=${2:-ota/latest.json}

: "${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID}"
: "${R2_BUCKET:?Set R2_BUCKET}"
: "${R2_PUBLIC_BASE_URL:?Set R2_PUBLIC_BASE_URL}"
: "${OTA_MANIFEST_URL:?Set OTA_MANIFEST_URL}"
: "${OTA_VERSION:?Set OTA_VERSION}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"

for command_name in aws curl jq; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command is unavailable: $command_name" >&2
        exit 1
    fi
done

if [[ ! "$OTA_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "OTA_VERSION must be a stable semantic version: $OTA_VERSION" >&2
    exit 1
fi

endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
new_prefix="ota/releases/v${OTA_VERSION}/"
previous_manifest=$(mktemp)
trap 'rm -f "$previous_manifest"' EXIT

public_base_url=${R2_PUBLIC_BASE_URL%/}
expected_manifest_url="${public_base_url}/ota/latest.json"
if [[ ! "$public_base_url" =~ ^https:// ]]; then
    echo "R2_PUBLIC_BASE_URL must use HTTPS: $public_base_url" >&2
    exit 1
fi
if [[ "$OTA_MANIFEST_URL" != "$expected_manifest_url" ]]; then
    echo "OTA_MANIFEST_URL must equal $expected_manifest_url" >&2
    exit 1
fi

manifest_version=$(jq -r '.version // empty' "$manifest_file")
manifest_schema=$(jq -r '.schema_version // empty' "$manifest_file")
manifest_asset_count=$(jq -r '.assets | length' "$manifest_file")
if [[ "$manifest_version" != "$OTA_VERSION" || "$manifest_schema" != "1" || \
    "$manifest_asset_count" != "3" ]]; then
    echo "Generated OTA manifest has an invalid version, schema, or asset count." >&2
    exit 1
fi

artifact_names=(
    FutureAcademy-win.zip
    FutureAcademy-arm64.zip
    FutureAcademy-intel.zip
)
for artifact_name in "${artifact_names[@]}"; do
    artifact_path="${artifacts_dir}/${artifact_name}"
    expected_url="${public_base_url}/${new_prefix}${artifact_name}"
    if [[ ! -f "$artifact_path" ]]; then
        echo "Missing OTA artifact: $artifact_path" >&2
        exit 1
    fi
    if ! jq -e --arg name "$artifact_name" --arg url "$expected_url" \
        '[.assets[] | select(.name == $name and .url == $url)] | length == 1' \
        "$manifest_file" >/dev/null; then
        echo "Manifest is missing the expected asset mapping: $artifact_name" >&2
        exit 1
    fi
done

verify_public_assets() {
    local source_manifest=$1
    local label=$2
    local url
    local url_count=0
    local cache_buster="verify-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

    while IFS= read -r url; do
        url_count=$((url_count + 1))
        if [[ ! "$url" =~ ^https:// ]]; then
            echo "$label contains a non-HTTPS URL: $url" >&2
            return 1
        fi
        echo "Checking $label asset: $url"
        if ! curl --fail --silent --show-error --head \
            --retry 5 --retry-delay 2 --retry-all-errors \
            "${url}?${cache_buster}" >/dev/null; then
            echo "$label asset is unavailable: $url" >&2
            return 1
        fi
    done < <(jq -r '.assets[]?.url // empty' "$source_manifest")

    if (( url_count != 3 )); then
        echo "$label does not contain exactly three asset URLs." >&2
        return 1
    fi
}

list_release_prefixes() {
    aws s3api list-objects-v2 \
        --endpoint-url "$endpoint" \
        --bucket "$R2_BUCKET" \
        --prefix "ota/releases/" \
        --delimiter "/" \
        --query "CommonPrefixes[].Prefix" \
        --output text |
        tr '\t' '\n' |
        sed '/^$/d'
}

prune_except() {
    local keep_primary=$1
    local keep_fallback=${2:-}
    local prefix

    while IFS= read -r prefix; do
        if [[ ! "$prefix" =~ ^ota/releases/v[0-9]+\.[0-9]+\.[0-9]+/$ ]]; then
            echo "Ignoring unexpected R2 prefix: $prefix"
            continue
        fi
        if [[ "$prefix" == "$keep_primary" || "$prefix" == "$keep_fallback" ]]; then
            echo "Keeping OTA release: $prefix"
            continue
        fi

        echo "Pruning OTA release: $prefix"
        aws s3 rm "s3://${R2_BUCKET}/${prefix}" \
            --endpoint-url "$endpoint" \
            --recursive
    done < <(list_release_prefixes)
}

fallback_version=''
fallback_prefix=''
fallback_verified=false

if aws s3 cp "s3://${R2_BUCKET}/ota/latest.json" "$previous_manifest" \
    --endpoint-url "$endpoint" --only-show-errors 2>/dev/null; then
    fallback_version=$(jq -r '.version // empty' "$previous_manifest")
    if [[ "$fallback_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && \
        verify_public_assets "$previous_manifest" "fallback v${fallback_version}"; then
        fallback_prefix="ota/releases/v${fallback_version}/"
        fallback_verified=true
        echo "Verified fallback release: v${fallback_version}"

        # Remove releases older than the fallback before uploading. This keeps
        # peak storage at approximately two complete releases.
        prune_except "$fallback_prefix"
    else
        echo "Existing manifest is not a healthy fallback; pre-upload pruning is skipped."
    fi
else
    echo "No existing OTA manifest found; treating this as the first R2 release."
fi

for archive_name in "${artifact_names[@]}"; do
    archive="${artifacts_dir}/${archive_name}"
    object_key="${new_prefix}${archive_name}"
    echo "Uploading OTA archive: $object_key"
    aws s3 cp "$archive" "s3://${R2_BUCKET}/${object_key}" \
        --endpoint-url "$endpoint" \
        --content-type application/zip \
        --cache-control "public,max-age=31536000,immutable" \
        --only-show-errors

    local_size=$(wc -c < "$archive" | tr -d ' ')
    remote_size=$(aws s3api head-object \
        --endpoint-url "$endpoint" \
        --bucket "$R2_BUCKET" \
        --key "$object_key" \
        --query ContentLength \
        --output text)
    if [[ "$local_size" != "$remote_size" ]]; then
        echo "R2 size mismatch for $archive_name: local=$local_size remote=$remote_size" >&2
        exit 1
    fi
done

verify_public_assets "$manifest_file" "new v${OTA_VERSION}"

# The manifest is the publication pointer and must always be uploaded last.
aws s3 cp "$manifest_file" "s3://${R2_BUCKET}/ota/latest.json" \
    --endpoint-url "$endpoint" \
    --content-type application/json \
    --cache-control "no-cache,no-store,must-revalidate" \
    --only-show-errors

manifest_visible=false
for attempt in $(seq 1 20); do
    cache_buster="run-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${attempt}"
    public_manifest=$(curl --fail --silent --show-error \
        --header "Cache-Control: no-cache" \
        "${OTA_MANIFEST_URL}?${cache_buster}" 2>/dev/null || true)
    if jq -e --arg version "$OTA_VERSION" '.version == $version' \
        >/dev/null 2>&1 <<< "$public_manifest"; then
        manifest_visible=true
        echo "Public OTA manifest now reports v${OTA_VERSION}."
        break
    fi
    echo "Waiting for public OTA manifest to report v${OTA_VERSION} (${attempt}/20)..."
    sleep 3
done

if [[ "$manifest_visible" != true ]]; then
    echo "Public OTA manifest did not update to v${OTA_VERSION}; pruning is skipped." >&2
    exit 1
fi

if [[ "$fallback_verified" == true ]] && \
    verify_public_assets "$previous_manifest" "fallback v${fallback_version}"; then
    prune_except "$new_prefix" "$fallback_prefix"
    echo "R2 reconciliation complete; retained v${OTA_VERSION} and v${fallback_version}."
else
    echo "No verified fallback is available; final pruning is skipped."
fi
