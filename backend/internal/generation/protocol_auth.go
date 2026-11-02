package generation

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"qisitv/backend/internal/protocol"

	"github.com/volcengine/volc-sdk-golang/base"
)

func ApplyProtocolAuth(req *http.Request, config Config, auth protocol.ManifestAuth) error {
	typeName := strings.ToLower(strings.TrimSpace(auth.Type))
	if typeName == "" {
		ApplyAuth(req, config)
		return nil
	}
	credential := ProtocolCredentialField(config, auth.Field)
	if idle, _ := req.Context().Value(videoDeliveryRequestContext{}).(time.Duration); idle > 0 {
		credentials, _ := req.Context().Value(videoCredentialContext{}).(videoProviderCredentials)
		credentials.Origin = config.BaseURL
		credentials.Values = append(credentials.Values, credential, auth.Prefix+credential, ProtocolCredentialField(config, auth.SecretField))
		*req = *req.WithContext(context.WithValue(req.Context(), videoCredentialContext{}, credentials))
	}
	switch typeName {
	case "none":
		return nil
	case "bearer":
		header := defaultString(strings.TrimSpace(auth.Header), "Authorization")
		prefix := auth.Prefix
		if prefix == "" {
			prefix = "Bearer "
		}
		req.Header.Set(header, prefix+credential)
		return nil
	case "header", "api-key", "apikey":
		header := strings.TrimSpace(auth.Header)
		if header == "" {
			return errors.New("插件 header 鉴权缺少 header 名称")
		}
		req.Header.Set(header, auth.Prefix+credential)
		return nil
	case "query":
		name := defaultString(strings.TrimSpace(auth.Query), strings.TrimSpace(auth.Field))
		if name == "" {
			return errors.New("插件 query 鉴权缺少参数名")
		}
		if idle, _ := req.Context().Value(videoDeliveryRequestContext{}).(time.Duration); idle > 0 {
			setVideoCredentialQuery(req.URL, name, auth.Prefix+credential)
			return nil
		}
		query := req.URL.Query()
		query.Set(name, auth.Prefix+credential)
		req.URL.RawQuery = query.Encode()
		return nil
	case "basic":
		username := auth.Username
		if username == "" {
			username = credential
		}
		password := ProtocolCredentialField(config, auth.SecretField)
		req.SetBasicAuth(username, password)
		return nil
	case "anthropic":
		req.Header.Set(defaultString(auth.Header, "x-api-key"), credential)
		if req.Header.Get("anthropic-version") == "" {
			req.Header.Set("anthropic-version", "2023-06-01")
		}
		return nil
	case "google-api-key", "gemini":
		req.Header.Set(defaultString(auth.Header, "x-goog-api-key"), credential)
		return nil
	case "volcengine-v4":
		secret := ProtocolCredentialField(config, auth.SecretField)
		if credential == "" || secret == "" {
			return errors.New("火山引擎 V4 鉴权需要 Access Key 和 Secret Key")
		}
		credentials := base.Credentials{
			AccessKeyID: credential, SecretAccessKey: secret,
			Region:  defaultString(strings.TrimSpace(auth.Region), "cn-north-1"),
			Service: strings.TrimSpace(auth.Service),
		}
		if credentials.Service == "" {
			return errors.New("火山引擎 V4 鉴权缺少 service")
		}
		signed := credentials.Sign(req)
		*req = *signed
		return nil
	case "aws-sigv4":
		secret := ProtocolCredentialField(config, auth.SecretField)
		return SignProtocolAWSV4(req, credential, secret, auth)
	case "tc3":
		secret := ProtocolCredentialField(config, auth.SecretField)
		return SignProtocolTC3(req, credential, secret, auth)
	case "jwt-hs256", "kling-jwt":
		secret := ProtocolCredentialField(config, auth.SecretField)
		if secret == "" {
			if credential == "" {
				return errors.New("JWT HS256 鉴权需要 Access Key 和 Secret Key（或已签名的 Bearer Token）")
			}
			header := defaultString(strings.TrimSpace(auth.Header), "Authorization")
			prefix := auth.Prefix
			if prefix == "" {
				prefix = "Bearer "
			}
			req.Header.Set(header, prefix+credential)
			return nil
		}
		return SignProtocolJWTHS256(req, credential, secret, auth)
	default:
		return fmt.Errorf("插件声明了尚未启用的鉴权驱动 %s", auth.Type)
	}
}

func SignProtocolAWSV4(req *http.Request, accessKey, secretKey string, auth protocol.ManifestAuth) error {
	if strings.TrimSpace(accessKey) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("AWS SigV4 鉴权需要 Access Key ID 和 Secret Access Key")
	}
	serviceName := defaultString(strings.TrimSpace(auth.Service), "bedrock")
	region := strings.TrimSpace(auth.Region)
	if region == "" {
		parts := strings.Split(strings.ToLower(req.URL.Hostname()), ".")
		for index, part := range parts {
			if strings.HasPrefix(part, serviceName) && index+1 < len(parts) {
				region = parts[index+1]
				break
			}
		}
	}
	if region == "" {
		return errors.New("AWS SigV4 鉴权无法从 Base URL 推断 region，请使用包含区域的 Bedrock Runtime 地址")
	}
	payload, err := ProtocolRequestPayload(req)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := Sha256Hex(payload)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	canonicalHeaders, signedHeaders := ProtocolCanonicalHeaders(req)
	canonicalRequest := strings.Join([]string{
		req.Method,
		defaultString(req.URL.EscapedPath(), "/"),
		req.URL.Query().Encode(),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
	scope := strings.Join([]string{dateStamp, region, serviceName, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, Sha256Hex([]byte(canonicalRequest))}, "\n")
	dateKey := ProtocolHMAC([]byte("AWS4"+secretKey), dateStamp)
	regionKey := ProtocolHMAC(dateKey, region)
	serviceKey := ProtocolHMAC(regionKey, serviceName)
	signingKey := ProtocolHMAC(serviceKey, "aws4_request")
	signature := hex.EncodeToString(ProtocolHMAC(signingKey, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, scope, signedHeaders, signature))
	return nil
}

func SignProtocolTC3(req *http.Request, secretID, secretKey string, auth protocol.ManifestAuth) error {
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("腾讯云 TC3 鉴权需要 SecretId 和 SecretKey")
	}
	serviceName := defaultString(strings.TrimSpace(auth.Service), "hunyuan")
	payload, err := ProtocolRequestPayload(req)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	timestamp := now.Unix()
	dateStamp := now.Format("2006-01-02")
	contentType := defaultString(req.Header.Get("Content-Type"), "application/json")
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(timestamp, 10))
	if region := strings.TrimSpace(auth.Region); region != "" {
		req.Header.Set("X-TC-Region", region)
	}
	canonicalHeaders := "content-type:" + strings.ToLower(strings.TrimSpace(contentType)) + "\n" + "host:" + strings.ToLower(req.URL.Host) + "\n"
	signedHeaders := "content-type;host"
	canonicalRequest := strings.Join([]string{req.Method, defaultString(req.URL.EscapedPath(), "/"), req.URL.Query().Encode(), canonicalHeaders, signedHeaders, Sha256Hex(payload)}, "\n")
	scope := dateStamp + "/" + serviceName + "/tc3_request"
	stringToSign := strings.Join([]string{"TC3-HMAC-SHA256", strconv.FormatInt(timestamp, 10), scope, Sha256Hex([]byte(canonicalRequest))}, "\n")
	secretDate := ProtocolHMAC([]byte("TC3"+secretKey), dateStamp)
	secretService := ProtocolHMAC(secretDate, serviceName)
	secretSigning := ProtocolHMAC(secretService, "tc3_request")
	signature := hex.EncodeToString(ProtocolHMAC(secretSigning, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf("TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", secretID, scope, signedHeaders, signature))
	return nil
}

func SignProtocolJWTHS256(req *http.Request, accessKey, secretKey string, auth protocol.ManifestAuth) error {
	accessKey = strings.TrimSpace(accessKey)
	secretKey = strings.TrimSpace(secretKey)
	if accessKey == "" || secretKey == "" {
		return errors.New("JWT HS256 鉴权需要 Access Key 和 Secret Key")
	}
	now := time.Now().UTC().Unix()
	headerJSON, err := json.Marshal(map[string]string{
		"alg": "HS256",
		"typ": "JWT",
	})
	if err != nil {
		return err
	}
	payloadJSON, err := json.Marshal(map[string]any{
		"iss": accessKey,
		"exp": now + 1800,
		"nbf": now - 5,
	})
	if err != nil {
		return err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(payloadJSON)
	signature := base64.RawURLEncoding.EncodeToString(ProtocolHMAC([]byte(secretKey), signingInput))
	token := signingInput + "." + signature
	header := defaultString(strings.TrimSpace(auth.Header), "Authorization")
	prefix := auth.Prefix
	if prefix == "" {
		prefix = "Bearer "
	}
	req.Header.Set(header, prefix+token)
	return nil
}

func ProtocolRequestPayload(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	var reader io.ReadCloser
	var err error
	if req.GetBody != nil {
		reader, err = req.GetBody()
	} else {
		reader = req.Body
	}
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(reader)
	if req.GetBody != nil {
		_ = reader.Close()
	} else {
		req.Body = io.NopCloser(bytes.NewReader(data))
	}
	return data, err
}

func ProtocolCanonicalHeaders(req *http.Request) (string, string) {
	values := map[string]string{"host": strings.ToLower(req.URL.Host)}
	for name, entries := range req.Header {
		lower := strings.ToLower(strings.TrimSpace(name))
		if lower == "authorization" || lower == "user-agent" || lower == "content-length" || lower == "expect" {
			continue
		}
		cleaned := make([]string, 0, len(entries))
		for _, entry := range entries {
			cleaned = append(cleaned, strings.Join(strings.Fields(entry), " "))
		}
		values[lower] = strings.Join(cleaned, ",")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for _, key := range keys {
		canonical.WriteString(key)
		canonical.WriteByte(':')
		canonical.WriteString(values[key])
		canonical.WriteByte('\n')
	}
	return canonical.String(), strings.Join(keys, ";")
}

func ProtocolHMAC(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func Sha256Hex(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func ProtocolCredentialField(config Config, field string) string {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "secretkey", "secret_key", "secret":
		return strings.TrimSpace(config.SecretKey)
	default:
		return strings.TrimSpace(config.APIKey)
	}
}
