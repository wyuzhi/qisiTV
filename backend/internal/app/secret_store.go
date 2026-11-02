package app

import "qisitv/backend/internal/localcrypto"

const encryptedSettingPrefix = localcrypto.Prefix

func (s *Service) taskSecrets() localcrypto.TaskCodec {
	return localcrypto.TaskCodec{DataDir: s.dataDir}
}
func (s *Service) encryptSettingSecret(value string) (string, error) {
	return s.taskSecrets().Encrypt(value)
}
func (s *Service) decryptSettingSecret(value string) (string, error) {
	return s.taskSecrets().Decrypt(value)
}
func (s *Service) settingsEncryptionKey() ([]byte, error) { return s.taskSecrets().Key() }
func (s *Service) protectTaskSecrets(value any) error     { return s.taskSecrets().Protect(value) }
func (s *Service) decryptTaskInputJSON(raw string) (string, error) {
	return s.taskSecrets().DecryptInputJSON(raw)
}
