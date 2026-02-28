package kube

import (
	"testing"
)

func TestEnvFloat(t *testing.T) {
	tests := []struct {
		name     string
		envVal   string
		fallback float64
		want     float64
	}{
		{"empty env uses fallback", "", 40.0, 40.0},
		{"valid float parsed", "100.5", 40.0, 100.5},
		{"zero uses fallback (non-positive)", "0", 40.0, 40.0},
		{"negative uses fallback", "-10", 40.0, 40.0},
		{"non-numeric uses fallback", "abc", 40.0, 40.0},
		{"integer-like string parsed", "200", 40.0, 200.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TEST_ENV_FLOAT_KEY", tt.envVal)
			got := envFloat("TEST_ENV_FLOAT_KEY", tt.fallback)
			if got != tt.want {
				t.Errorf("envFloat(%q) = %v, want %v", tt.envVal, got, tt.want)
			}
		})
	}
}

func TestEnvInt(t *testing.T) {
	tests := []struct {
		name     string
		envVal   string
		fallback int
		want     int
	}{
		{"empty env uses fallback", "", 80, 80},
		{"valid int parsed", "120", 80, 120},
		{"zero uses fallback (non-positive)", "0", 80, 80},
		{"negative uses fallback", "-5", 80, 80},
		{"float string uses fallback", "3.14", 80, 80},
		{"non-numeric uses fallback", "nan", 80, 80},
		{"large value parsed", "1000", 80, 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TEST_ENV_INT_KEY", tt.envVal)
			got := envInt("TEST_ENV_INT_KEY", tt.fallback)
			if got != tt.want {
				t.Errorf("envInt(%q) = %d, want %d", tt.envVal, got, tt.want)
			}
		})
	}
}
