package skills

// RetireExternalSkills removes legacy shared-directory imports from active use.
// Their immutable packages remain stored for historical references.
func (s *Service) RetireExternalSkills() error {
	return s.repo.RetireExternalSkills()
}
