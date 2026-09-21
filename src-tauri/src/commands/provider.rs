//! Model providers: the models.json catalogue, model discovery, and the provider service process.

use crate::*;

pub(crate) const PROVIDER_SERVICE_RUNTIME_ID: &str = "pidesktop-provider-service";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ModelProviderModel {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) reasoning: bool,
    pub(crate) input: Vec<String>,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_tokens: Option<u64>,
}

impl Default for ModelProviderModel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            reasoning: false,
            input: vec!["text".to_string()],
            context_window: None,
            max_tokens: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProviderConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api: String,
    pub(crate) has_api_key: bool,
    pub(crate) api_key_source: String,
    pub(crate) auth_header: bool,
    pub(crate) models: Vec<ModelProviderModel>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ModelProviderInput {
    pub(crate) original_id: Option<String>,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api: String,
    pub(crate) api_key: String,
    pub(crate) keep_existing_api_key: bool,
    pub(crate) auth_header: bool,
    pub(crate) models: Vec<ModelProviderModel>,
}

impl Default for ModelProviderInput {
    fn default() -> Self {
        Self {
            original_id: None,
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            api: "openai-completions".to_string(),
            api_key: String::new(),
            keep_existing_api_key: false,
            auth_header: false,
            models: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ModelProviderCheckResult {
    pub(crate) ok: bool,
    pub(crate) message: String,
}

pub(crate) fn save_models_config(value: &serde_json::Value) -> Result<(), AppError> {
    let path = models_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::Io(format!("无法创建 Pi 配置目录: {err}")))?;
    }
    if path.exists() {
        let backup = path.with_extension("json.pidesktop.bak");
        fs::copy(&path, &backup)
            .map_err(|err| AppError::Io(format!("无法备份 models.json: {err}")))?;
    }
    let raw = serde_json::to_string_pretty(value)
        .map_err(|err| AppError::Other(format!("无法序列化 models.json: {err}")))?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|err| AppError::Io(format!("无法写入 {}: {err}", path.display())))
}

pub(crate) fn api_key_source(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => "none",
        Some(value) if value.starts_with('!') => "command",
        Some(value) if value.starts_with('$') => "environment",
        Some(_) => "stored",
    }
    .to_string()
}

pub(crate) fn model_from_value(value: &serde_json::Value) -> Option<ModelProviderModel> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(ModelProviderModel {
        name: object
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(&id)
            .to_string(),
        reasoning: object
            .get("reasoning")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        input: object
            .get("input")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .filter(|values: &Vec<String>| !values.is_empty())
            .unwrap_or_else(|| vec!["text".to_string()]),
        context_window: object.get("contextWindow").and_then(|value| value.as_u64()),
        max_tokens: object.get("maxTokens").and_then(|value| value.as_u64()),
        id,
    })
}

pub(crate) fn validate_model_provider(provider: &ModelProviderInput) -> Result<(), AppError> {
    let id = provider.id.trim();
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(AppError::InvalidInput(
            "提供商 ID 只能包含字母、数字、点、短横线和下划线".to_string(),
        ));
    }
    if provider.original_id.is_none() && provider.models.is_empty() {
        return Err(AppError::InvalidInput(
            "新提供商至少需要配置一个模型".to_string(),
        ));
    }
    if provider.original_id.is_none() && provider.base_url.trim().is_empty() {
        return Err(AppError::InvalidInput("新提供商需要 API 地址".to_string()));
    }
    if !(provider.base_url.trim().is_empty()
        || provider.base_url.starts_with("http://")
        || provider.base_url.starts_with("https://"))
    {
        return Err(AppError::InvalidInput(
            "API 地址必须以 http:// 或 https:// 开头".to_string(),
        ));
    }
    let supported_apis = [
        "anthropic-messages",
        "openai-completions",
        "openai-responses",
        "azure-openai-responses",
        "openai-codex-responses",
        "mistral-conversations",
        "google-generative-ai",
        "google-vertex",
        "bedrock-converse-stream",
    ];
    if !provider.api.trim().is_empty() && !supported_apis.contains(&provider.api.as_str()) {
        return Err(AppError::InvalidInput("不支持的 Pi API 协议".to_string()));
    }
    let mut model_ids = std::collections::HashSet::new();
    for model in &provider.models {
        let model_id = model.id.trim();
        if model_id.is_empty() || !model_ids.insert(model_id.to_string()) {
            return Err(AppError::InvalidInput(
                "模型 ID 必须非空且不能重复".to_string(),
            ));
        }
        if model.context_window == Some(0) || model.max_tokens == Some(0) {
            return Err(AppError::InvalidInput(format!(
                "模型 {model_id} 的 token 数必须大于 0"
            )));
        }
    }
    Ok(())
}

pub(crate) fn configured_provider_api_key(
    provider: &ModelProviderInput,
) -> Result<Option<String>, AppError> {
    let configured = if !provider.api_key.trim().is_empty() {
        Some(provider.api_key.trim().to_string())
    } else if provider.keep_existing_api_key {
        let provider_id = provider
            .original_id
            .as_deref()
            .unwrap_or(provider.id.as_str())
            .trim();
        load_models_config()?
            .get("providers")
            .and_then(|value| value.get(provider_id))
            .and_then(|value| value.get("apiKey"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    } else {
        None
    };
    configured
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_provider_config_value(&value))
        .transpose()
}

pub(crate) fn resolve_provider_config_value(value: &str) -> Result<String, AppError> {
    if let Some(script) = value.strip_prefix('!') {
        if script.trim().is_empty() {
            return Err(AppError::InvalidInput("API 密钥命令不能为空".to_string()));
        }
        #[cfg(windows)]
        let output = hidden_command("cmd.exe")
            .args(["/D", "/S", "/C", script])
            .output();
        #[cfg(not(windows))]
        let output = hidden_command("/bin/sh").args(["-lc", script]).output();
        let output = output.map_err(|_| AppError::Process("无法执行 API 密钥命令".to_string()))?;
        if !output.status.success() {
            return Err(AppError::Process("API 密钥命令执行失败".to_string()));
        }
        let secret = String::from_utf8(output.stdout)
            .map_err(|_| AppError::Other("API 密钥命令没有返回有效文本".to_string()))?
            .trim()
            .to_string();
        if secret.is_empty() {
            return Err(AppError::Other("API 密钥命令返回了空值".to_string()));
        }
        return Ok(secret);
    }

    let characters = value.chars().collect::<Vec<_>>();
    let mut resolved = String::with_capacity(value.len());
    let mut index = 0;
    while index < characters.len() {
        if characters[index] != '$' {
            resolved.push(characters[index]);
            index += 1;
            continue;
        }
        let Some(next) = characters.get(index + 1).copied() else {
            resolved.push('$');
            break;
        };
        if next == '$' || next == '!' {
            resolved.push(if next == '$' { '$' } else { '!' });
            index += 2;
            continue;
        }

        let (name, next_index) = if next == '{' {
            let end = characters[index + 2..]
                .iter()
                .position(|character| *character == '}')
                .map(|offset| index + 2 + offset)
                .ok_or_else(|| {
                    AppError::InvalidInput("API 密钥中的环境变量缺少右花括号".to_string())
                })?;
            (
                characters[index + 2..end].iter().collect::<String>(),
                end + 1,
            )
        } else if next.is_ascii_alphanumeric() || next == '_' {
            let mut end = index + 1;
            while end < characters.len()
                && (characters[end].is_ascii_alphanumeric() || characters[end] == '_')
            {
                end += 1;
            }
            (characters[index + 1..end].iter().collect::<String>(), end)
        } else {
            resolved.push('$');
            index += 1;
            continue;
        };
        if name.is_empty() {
            return Err(AppError::InvalidInput(
                "API 密钥中的环境变量名称不能为空".to_string(),
            ));
        }
        let environment_value = std::env::var(&name)
            .map_err(|_| AppError::NotFound(format!("环境变量 {name} 未设置，无法拉取模型")))?;
        resolved.push_str(&environment_value);
        index = next_index;
    }
    Ok(resolved)
}

pub(crate) fn provider_models_endpoint(base_url: &str, api: &str) -> Result<String, AppError> {
    let base_url = base_url.trim().trim_end_matches('/');
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(AppError::InvalidInput(
            "自动拉取需要有效的 http:// 或 https:// API 地址".to_string(),
        ));
    }
    if base_url.contains('?') || base_url.contains('#') {
        return Err(AppError::InvalidInput(
            "自动拉取使用的 API 地址不能包含查询参数或片段".to_string(),
        ));
    }
    if matches!(
        api,
        "azure-openai-responses" | "google-vertex" | "bedrock-converse-stream"
    ) {
        return Err(AppError::InvalidInput(format!(
            "{} 没有可从当前 API 地址通用枚举的模型接口，请手动添加模型",
            match api {
                "azure-openai-responses" => "Azure OpenAI",
                "google-vertex" => "Google Vertex AI",
                _ => "Amazon Bedrock",
            }
        )));
    }
    if base_url.ends_with("/models") {
        return Ok(base_url.to_string());
    }
    let after_origin = base_url
        .split_once("://")
        .map(|(_, value)| value)
        .unwrap_or(base_url);
    let has_path = after_origin
        .split_once('/')
        .is_some_and(|(_, path)| !path.trim_matches('/').is_empty());
    let default_version = if api == "google-generative-ai" {
        "v1beta"
    } else {
        "v1"
    };
    if has_path {
        Ok(format!("{base_url}/models"))
    } else {
        Ok(format!("{base_url}/{default_version}/models"))
    }
}

pub(crate) fn discovered_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })
}

pub(crate) fn discovered_string_array_contains(
    value: Option<&serde_json::Value>,
    needle: &str,
) -> bool {
    value
        .and_then(|value| value.as_array())
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|text| text.to_ascii_lowercase().contains(needle))
            })
        })
}

pub(crate) fn discovered_model_from_value(
    value: &serde_json::Value,
    api: &str,
) -> Option<ModelProviderModel> {
    if let Some(id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) {
        return Some(ModelProviderModel {
            id: id.to_string(),
            name: id.to_string(),
            ..Default::default()
        });
    }
    let object = value.as_object()?;
    if api == "google-generative-ai"
        && object.get("supportedGenerationMethods").is_some()
        && !discovered_string_array_contains(
            object.get("supportedGenerationMethods"),
            "generatecontent",
        )
    {
        return None;
    }
    let raw_id = object
        .get("id")
        .or_else(|| object.get("name"))
        .and_then(|value| value.as_str())?
        .trim();
    let id = if api == "google-generative-ai" {
        raw_id.strip_prefix("models/").unwrap_or(raw_id)
    } else {
        raw_id
    };
    if id.is_empty() {
        return None;
    }
    let name = ["display_name", "displayName", "label", "title"]
        .iter()
        .find_map(|field| object.get(*field).and_then(|value| value.as_str()))
        .or_else(|| {
            object
                .get("id")
                .and_then(|_| object.get("name"))
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id)
        .to_string();
    let reasoning = object
        .get("reasoning")
        .and_then(|value| value.as_bool())
        .or_else(|| {
            object
                .get("supports_reasoning")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(false)
        || discovered_string_array_contains(object.get("supported_parameters"), "reasoning");
    let supports_image = object
        .get("vision")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || value
            .pointer("/capabilities/vision")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        || [
            object.get("input"),
            object.get("input_modalities"),
            object.get("modalities"),
            value.pointer("/architecture/input_modalities"),
        ]
        .into_iter()
        .any(|value| discovered_string_array_contains(value, "image"));
    Some(ModelProviderModel {
        id: id.to_string(),
        name,
        reasoning,
        input: if supports_image {
            vec!["text".to_string(), "image".to_string()]
        } else {
            vec!["text".to_string()]
        },
        context_window: [
            object.get("context_window"),
            object.get("contextWindow"),
            object.get("context_length"),
            object.get("inputTokenLimit"),
            value.pointer("/capabilities/context_window"),
        ]
        .into_iter()
        .find_map(discovered_u64),
        max_tokens: [
            object.get("max_tokens"),
            object.get("maxTokens"),
            object.get("max_output_tokens"),
            object.get("outputTokenLimit"),
            value.pointer("/top_provider/max_completion_tokens"),
        ]
        .into_iter()
        .find_map(discovered_u64),
    })
}

pub(crate) fn parse_discovered_model_catalog(
    value: &serde_json::Value,
    api: &str,
) -> Result<Vec<ModelProviderModel>, AppError> {
    let items = value
        .get("data")
        .and_then(|value| value.as_array())
        .or_else(|| value.get("models").and_then(|value| value.as_array()))
        .or_else(|| value.as_array())
        .ok_or_else(|| {
            AppError::Network("模型接口返回的数据中没有 data 或 models 列表".to_string())
        })?;
    let mut models = HashMap::new();
    for item in items {
        if let Some(model) = discovered_model_from_value(item, api) {
            models.entry(model.id.clone()).or_insert(model);
        }
    }
    let mut models = models.into_values().collect::<Vec<_>>();
    models.sort_by_key(|model| model.id.to_lowercase());
    if models.is_empty() {
        return Err(AppError::NotFound(
            "模型接口没有返回可用于生成内容的模型".to_string(),
        ));
    }
    Ok(models)
}

pub(crate) fn discover_model_provider_models_blocking(
    provider: ModelProviderInput,
) -> Result<Vec<ModelProviderModel>, AppError> {
    let api = provider.api.trim();
    let endpoint = provider_models_endpoint(&provider.base_url, api)?;
    let api_key = configured_provider_api_key(&provider)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .user_agent("PiDesktop/0.2 model-discovery")
        .build();
    let mut request = agent.get(&endpoint).set("Accept", "application/json");
    if let Some(api_key) = api_key.as_deref() {
        if provider.auth_header || !matches!(api, "anthropic-messages" | "google-generative-ai") {
            request = request.set("Authorization", &format!("Bearer {api_key}"));
        } else if api == "anthropic-messages" {
            request = request
                .set("x-api-key", api_key)
                .set("anthropic-version", "2023-06-01");
        } else {
            request = request.set("x-goog-api-key", api_key);
        }
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(AppError::Network(format!(
                "提供商模型接口返回 HTTP {status}，请检查 API 地址、协议和密钥"
            )));
        }
        Err(ureq::Error::Transport(error)) => {
            return Err(AppError::Network(format!(
                "无法连接提供商模型接口: {error}"
            )));
        }
    };
    const MAX_CATALOG_BYTES: u64 = 8 * 1024 * 1024;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::Network(format!("无法读取提供商模型列表: {error}")))?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err(AppError::InvalidInput(
            "提供商模型列表超过 8 MB，已停止读取".to_string(),
        ));
    }
    let value = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|error| AppError::Network(format!("提供商模型接口返回了无效 JSON: {error}")))?;
    parse_discovered_model_catalog(&value, api)
}

#[tauri::command]
pub(crate) async fn discover_model_provider_models(
    provider: ModelProviderInput,
) -> Result<Vec<ModelProviderModel>, AppError> {
    tauri::async_runtime::spawn_blocking(move || discover_model_provider_models_blocking(provider))
        .await
        .map_err(|error| AppError::Process(format!("模型目录后台任务失败: {error}")))?
}

#[tauri::command(async)]
pub(crate) fn list_model_providers() -> Result<Vec<ModelProviderConfig>, AppError> {
    let config = load_models_config()?;
    let mut items = config
        .get("providers")
        .and_then(|value| value.as_object())
        .into_iter()
        .flat_map(|providers| providers.iter())
        .filter_map(|(id, value)| {
            let object = value.as_object()?;
            let key = object.get("apiKey").and_then(|value| value.as_str());
            Some(ModelProviderConfig {
                id: id.clone(),
                name: object
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or(id)
                    .to_string(),
                base_url: object
                    .get("baseUrl")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                api: object
                    .get("api")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                has_api_key: key.is_some_and(|value| !value.trim().is_empty()),
                api_key_source: api_key_source(key),
                auth_header: object
                    .get("authHeader")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                models: object
                    .get("models")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(model_from_value)
                    .collect(),
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(items)
}

#[tauri::command(async)]
pub(crate) fn save_model_provider(provider: ModelProviderInput) -> Result<(), AppError> {
    validate_model_provider(&provider)?;
    let id = provider.id.trim().to_string();
    if let Some(original_id) = provider.original_id.as_deref() {
        if original_id != id {
            return Err(AppError::InvalidInput(
                "编辑现有提供商时不能修改 ID".to_string(),
            ));
        }
    }

    let mut config = load_models_config()?;
    let root = config
        .as_object_mut()
        .ok_or_else(|| AppError::Other("models.json 的根节点必须是对象".to_string()))?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| AppError::Other("models.json 的 providers 必须是对象".to_string()))?;
    if provider.original_id.is_none() && providers.contains_key(&id) {
        return Err(AppError::InvalidInput(format!("提供商 {id} 已存在")));
    }

    let mut provider_object = providers
        .get(&id)
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let existing_models = provider_object
        .get("models")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if provider.name.trim().is_empty() || provider.name.trim() == id {
        provider_object.remove("name");
    } else {
        provider_object.insert("name".to_string(), serde_json::json!(provider.name.trim()));
    }
    if provider.base_url.trim().is_empty() {
        provider_object.remove("baseUrl");
    } else {
        provider_object.insert(
            "baseUrl".to_string(),
            serde_json::json!(provider.base_url.trim()),
        );
    }
    if provider.api.trim().is_empty() {
        provider_object.remove("api");
    } else {
        provider_object.insert("api".to_string(), serde_json::json!(provider.api.trim()));
    }
    if !provider.api_key.is_empty() {
        provider_object.insert("apiKey".to_string(), serde_json::json!(provider.api_key));
    } else if !provider.keep_existing_api_key {
        provider_object.remove("apiKey");
    }
    if provider.auth_header {
        provider_object.insert("authHeader".to_string(), serde_json::json!(true));
    } else {
        provider_object.remove("authHeader");
    }

    let models = provider
        .models
        .iter()
        .map(|model| {
            let mut object = existing_models
                .iter()
                .find(|value| {
                    value.get("id").and_then(|value| value.as_str()) == Some(model.id.trim())
                })
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            let model_id = model.id.trim();
            object.insert("id".to_string(), serde_json::json!(model_id));
            if model.name.trim().is_empty() || model.name.trim() == model_id {
                object.remove("name");
            } else {
                object.insert("name".to_string(), serde_json::json!(model.name.trim()));
            }
            if model.reasoning {
                object.insert("reasoning".to_string(), serde_json::json!(true));
            } else {
                object.remove("reasoning");
            }
            let supports_image = model.input.iter().any(|value| value == "image");
            if supports_image {
                object.insert("input".to_string(), serde_json::json!(["text", "image"]));
            } else {
                object.remove("input");
            }
            match model.context_window {
                Some(value) => {
                    object.insert("contextWindow".to_string(), serde_json::json!(value));
                }
                None => {
                    object.remove("contextWindow");
                }
            }
            match model.max_tokens {
                Some(value) => {
                    object.insert("maxTokens".to_string(), serde_json::json!(value));
                }
                None => {
                    object.remove("maxTokens");
                }
            }
            serde_json::Value::Object(object)
        })
        .collect::<Vec<_>>();
    provider_object.insert("models".to_string(), serde_json::Value::Array(models));
    providers.insert(id, serde_json::Value::Object(provider_object));
    save_models_config(&config)
}

#[tauri::command(async)]
pub(crate) fn delete_model_provider(id: String) -> Result<(), AppError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::InvalidInput("提供商 ID 不能为空".to_string()));
    }
    let mut config = load_models_config()?;
    let providers = config
        .get_mut("providers")
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| AppError::Other("models.json 的 providers 必须是对象".to_string()))?;
    if providers.remove(id).is_none() {
        return Err(AppError::NotFound(format!("未找到提供商 {id}")));
    }
    save_models_config(&config)
}

#[tauri::command(async)]
pub(crate) fn check_model_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<ModelProviderCheckResult, AppError> {
    let providers = list_model_providers()?;
    let provider = providers
        .iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| AppError::NotFound(format!("未找到提供商 {id}")))?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .clone();
    let pi_binary = effective_pi_binary(&settings, &state);

    #[cfg(windows)]
    let mut command = {
        let mut command = if let Some((node, cli)) = resolve_windows_pi_node_command(&pi_binary) {
            let mut command = Command::new(node);
            command.arg(cli).args(["--offline", "--list-models", &id]);
            command
        } else {
            let command_line = format!(
                "call \"{}\" --offline --list-models \"{}\"",
                pi_binary.replace('"', "\"\""),
                id
            );
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", &command_line]);
            command
        };
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&pi_binary);
        command.args(["--offline", "--list-models", &id]);
        command
    };
    let output = command
        .output()
        .map_err(|err| AppError::Process(format!("无法运行 Pi 配置检查: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8(output.stderr)
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|_| "Pi 配置检查命令执行失败，请确认 Pi 可执行文件设置".to_string());
        let stderr = redact_runtime_output(&settings, &stderr);
        return Ok(ModelProviderCheckResult {
            ok: false,
            message: if stderr.is_empty() {
                "Pi 未能加载该提供商配置".to_string()
            } else {
                stderr
            },
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let recognized = !stdout.trim().is_empty() && stdout.contains(&provider.id);
    Ok(ModelProviderCheckResult {
        ok: recognized,
        message: if recognized {
            format!("Pi 已识别 {} 个配置模型", provider.models.len())
        } else if !provider.has_api_key {
            "配置格式有效，但 Pi 暂未把模型标为可用；请配置 API 密钥或 auth.json 凭据".to_string()
        } else {
            "配置格式有效，但 Pi 的可用模型列表中尚未出现该提供商".to_string()
        },
    })
}

/// Start, or reuse, the Pi process that owns provider auth and catalogs for Settings.
/// It loads only the provider extension, so user resources cannot slow it down.
/// Spawning can stall (for example while antivirus scans pi.exe), so keep it off the UI thread.
#[tauri::command]
pub(crate) async fn provider_service_start(app: AppHandle) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_provider_service(&app, &state)
    })
    .await
    .map_err(|err| AppError::Process(format!("provider service worker failed: {err}")))?
}

pub(crate) fn start_provider_service(
    app: &AppHandle,
    state: &AppState,
) -> Result<String, AppError> {
    let mut service = state
        .provider_service
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
    if service.as_ref().is_some_and(|client| client.is_running()) {
        return Ok(PROVIDER_SERVICE_RUNTIME_ID.to_string());
    }
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .clone();
    let extension = ensure_providers_extension()?;
    let cwd = app_config_dir();
    fs::create_dir_all(&cwd).map_err(|err| {
        AppError::Io(format!(
            "failed to prepare provider service directory: {err}"
        ))
    })?;
    let args = [
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "-e",
    ]
    .into_iter()
    .map(str::to_string)
    .chain([extension.to_string_lossy().to_string()])
    .collect::<Vec<_>>();
    let client = PiRpcClient::spawn(
        app.clone(),
        PROVIDER_SERVICE_RUNTIME_ID,
        &effective_pi_binary(&settings, state),
        &cwd.to_string_lossy(),
        &args,
        &[],
        &runtime_secret_values(&settings),
    )?;
    *service = Some(client);
    Ok(PROVIDER_SERVICE_RUNTIME_ID.to_string())
}

#[tauri::command(async)]
pub(crate) fn provider_service_send(
    state: State<'_, AppState>,
    line: String,
) -> Result<(), AppError> {
    state
        .provider_service
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .as_ref()
        .filter(|client| client.is_running())
        .ok_or_else(|| AppError::NotFound("provider service is not running".to_string()))?
        .send_line(&line)
}

#[tauri::command(async)]
pub(crate) fn provider_service_stop(state: State<'_, AppState>) -> Result<(), AppError> {
    let client = state
        .provider_service
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .take();
    if let Some(client) = client {
        client.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_native_model_provider_input() {
        let provider = ModelProviderInput {
            id: "local-ollama".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            api_key: "ollama".to_string(),
            models: vec![ModelProviderModel {
                id: "qwen2.5-coder:7b".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(validate_model_provider(&provider).is_ok());
    }

    #[test]
    fn rejects_duplicate_provider_model_ids() {
        let provider = ModelProviderInput {
            id: "custom".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            models: vec![
                ModelProviderModel {
                    id: "same-model".to_string(),
                    ..Default::default()
                },
                ModelProviderModel {
                    id: "same-model".to_string(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert!(validate_model_provider(&provider).is_err());
    }

    #[test]
    fn builds_model_discovery_endpoints_for_supported_protocols() {
        assert_eq!(
            provider_models_endpoint("https://api.example.com", "openai-completions")
                .expect("OpenAI endpoint should be supported"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            provider_models_endpoint(
                "https://generativelanguage.googleapis.com/v1beta/",
                "google-generative-ai"
            )
            .expect("Google endpoint should be supported"),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
        assert!(provider_models_endpoint(
            "https://example.openai.azure.com",
            "azure-openai-responses"
        )
        .is_err());
    }

    #[test]
    fn parses_openai_compatible_model_catalog_metadata() {
        let catalog = serde_json::json!({
            "data": [{
                "id": "reasoning-vision",
                "name": "Reasoning Vision",
                "context_length": 131072,
                "supported_parameters": ["tools", "reasoning"],
                "architecture": { "input_modalities": ["text", "image"] },
                "top_provider": { "max_completion_tokens": 32768 }
            }]
        });
        let models = parse_discovered_model_catalog(&catalog, "openai-completions")
            .expect("catalog should parse");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "reasoning-vision");
        assert_eq!(models[0].name, "Reasoning Vision");
        assert!(models[0].reasoning);
        assert!(models[0].input.contains(&"image".to_string()));
        assert_eq!(models[0].context_window, Some(131072));
        assert_eq!(models[0].max_tokens, Some(32768));
    }

    #[test]
    fn parses_google_catalog_and_skips_embedding_only_models() {
        let catalog = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-example",
                    "displayName": "Gemini Example",
                    "inputTokenLimit": 1048576,
                    "outputTokenLimit": 8192,
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/text-embedding-example",
                    "supportedGenerationMethods": ["embedContent"]
                }
            ]
        });
        let models = parse_discovered_model_catalog(&catalog, "google-generative-ai")
            .expect("catalog should parse");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-example");
        assert_eq!(models[0].name, "Gemini Example");
        assert_eq!(models[0].context_window, Some(1048576));
        assert_eq!(models[0].max_tokens, Some(8192));
    }
}
