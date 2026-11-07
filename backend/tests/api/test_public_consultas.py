"""Techo de consultas del vivo público y de la cola del tatami.

En Azure SQL cada consulta es un viaje de red (~2 ms en la misma región, mucho
más con la base despertando): el vivo con 200–250 consultas tardaba 0,5 s por
cálculo y la cola del tatami, que la mesa pide seguido, 25–40. Estas pruebas
fijan el número de consultas en un torneo de 8 tatamis para que no vuelva a
crecer con el tamaño del torneo.
"""

from contextlib import contextmanager

import sqlalchemy as sa

from app.db import base
from app.services import brackets, public
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_stats import play

TATAMIS = 8
POR_CATEGORIA = 8
TECHO_VIVO = 15
TECHO_COLA = 10


@contextmanager
def contar():
    sqls: list[str] = []

    def uno(conn, cursor, statement, *args):
        sqls.append(statement)

    engine = base.get_engine()
    sa.event.listen(engine, "before_cursor_execute", uno)
    try:
        yield sqls
    finally:
        sa.event.remove(engine, "before_cursor_execute", uno)


def torneo_grande(api):
    """8 tatamis con una categoría de 8 cada uno: la del tatami 1 terminada,
    y en los demás un combate en curso y otro cerrado."""
    t = setup_tournament(api, tatami_count=TATAMIS, is_test=False)
    dojos = [api.dojo(f"Carga {i}") for i in range(4)]
    cats = []
    for i, tat in enumerate(t["tatamis"]):
        c = api.post(
            f"/tournaments/{t['id']}/categories", {**KUMITE, "code": f"K{i}", "name": f"Kumite {i}"}, expect=201
        )
        c = api.patch(f"/categories/{c['id']}", {"tatami_id": tat["id"], "version": c["version"]})
        for j in range(POR_CATEGORIA):
            p = api.person(f"T{i}", f"C{j}", dojos[j % len(dojos)]["id"])
            register(api, t["id"], p["id"], c["id"], weight_class="-45", override="carga")
        api.post(f"/categories/{c['id']}/bracket", {"seed": i + 1})
        cats.append(c)
    # Tatami 1: la categoría entera (con podio, medallero y premios).
    while True:
        q = api.get(f"/tatamis/{t['tatamis'][0]['id']}/queue")["queue"]
        if not q:
            break
        play(api, q[0]["match"]["id"], [("aka", 3), ("ao", 1)], "aka")
    # Los demás: un combate cerrado y otro en curso.
    for tat in t["tatamis"][1:]:
        q = api.get(f"/tatamis/{tat['id']}/queue")["queue"]
        play(api, q[0]["match"]["id"], [("ao", 2)], "ao")
        api.event(q[1]["match"]["id"], "start")
        api.event(q[1]["match"]["id"], "point", "aka", 1)
    token = api.c.put(f"/api/v1/tournaments/{t['id']}/public", json={"enabled": True}).json()["public_token"]
    return t, token


def test_vivo_y_cola_con_pocas_consultas(client):
    t, token = torneo_grande(client)
    db = next(base.get_session())
    try:
        with contar() as sqls:
            live = public.live(db, token)
        assert len(live["tatamis"]) == TATAMIS and live["results"] and live["medal_table"] and live["awards"]
        assert all(x["current"] for x in live["tatamis"][1:])
        assert len(sqls) <= TECHO_VIVO, f"vivo: {len(sqls)} consultas\n" + "\n".join(sqls)

        with contar() as sqls:
            q = brackets.tatami_queue(db, t["tatamis"][1]["id"])
        assert q["current"] and q["progress"]["done"] == 1
        assert len(sqls) <= TECHO_COLA, f"cola: {len(sqls)} consultas\n" + "\n".join(sqls)

        with contar() as sqls:
            public.overlay(db, token, t["tatamis"][1]["id"])
        assert len(sqls) <= TECHO_COLA, f"overlay: {len(sqls)} consultas\n" + "\n".join(sqls)
    finally:
        db.close()


def test_leer_la_llave_no_escribe(client):
    """El GET de la llave calcula en memoria: antes borraba e insertaba el
    podio en cada lectura y chocaba con las escrituras de la mesa."""
    t, _ = torneo_grande(client)
    cats = client.get(f"/tournaments/{t['id']}/categories")
    done = next(c for c in cats if c["status"] == "finished")
    busy = next(c for c in cats if c["status"] == "in_progress")
    for c in (done, busy):
        with contar() as sqls:
            b = client.get(f"/categories/{c['id']}/bracket")
        writes = [q for q in sqls if q.split()[0] in ("INSERT", "UPDATE", "DELETE")]
        assert writes == [], writes
        assert b["podium"]["complete"] is (c is done)
    podium = client.get(f"/categories/{done['id']}/bracket")["podium"]["places"]
    assert [p["place"] for p in podium] == [1, 2, 3, 3]
    assert {p["registration_id"] for p in podium} == {
        p["registration_id"]
        for r in client.get(f"/tournaments/{t['id']}/results")
        if r["category_id"] == done["id"]
        for p in r["places"]
    }
