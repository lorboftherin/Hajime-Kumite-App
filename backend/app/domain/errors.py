"""Errores de validación del dominio."""


class DomainError(ValueError):
    """Dato inválido según las reglas (grado mal escrito, nota fuera de rango, …).

    La API lo responde como 400 con el mensaje tal cual: está pensado para el
    usuario. Hereda de ValueError para que los validadores de Pydantic y el
    código que ya captura ValueError lo sigan tratando igual. Un ValueError
    cualquiera, en cambio, es un error de programación y se responde 500.
    """
