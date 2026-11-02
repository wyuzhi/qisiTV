package app

func (s *Service) decryptTaskSecrets(value any) error { return s.taskSecrets().DecryptValue(value) }
