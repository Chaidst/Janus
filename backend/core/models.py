from django.db import models

class Memory(models.Model):
    key = models.CharField(max_length=255, unique=True)
    value = models.TextField()
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.key}: {self.value[:50]}"
