from __future__ import annotations

from datetime import date

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import InvalidState, NotFound, WarningsRequireOverride
from app.db.base import utcnow
from app.db.models import (
    Branch,
    DataConsent,
    Dojo,
    DojoMembership,
    GradeRecord,
    IdentityDocument,
    JudgeVote,
    Person,
    PersonMerge,
    PersonRole,
    Registration,
    User,
)
from app.domain.categories import grade_to_ordinal
from app.domain.identity import PersonKey, find_duplicates, normalize_document, normalize_name
from app.services.audit import audit, bump, check_version, snapshot

# ---------------------------------------------------------------------------
# Dojos
# ---------------------------------------------------------------------------


def get_dojo(db: Session, dojo_id: int) -> Dojo:
    d = db.get(Dojo, dojo_id)
    if d is None:
        raise NotFound("Dojo no encontrado")
    return d


def create_dojo(db: Session, user: User, data: s.DojoCreate) -> Dojo:
    d = Dojo(
        name=data.name.strip(),
        short_name=data.short_name.strip(),
        city=data.city.strip(),
        is_independent=data.is_independent,
        updated_by_id=user.id,
    )
    db.add(d)
    db.flush()
    for b in data.branches:
        db.add(Branch(dojo_id=d.id, name=b.name.strip()))
    audit(db, user, "dojo", d.id, "create", after=snapshot(d))
    db.commit()
    db.refresh(d)
    return d


def create_dojo_nocommit(db: Session, user: User, name: str) -> Dojo:
    """Dojo creado manualmente (no reclamado), p. ej. desde una importación."""
    d = Dojo(name=name.strip(), updated_by_id=user.id)
    db.add(d)
    db.flush()
    audit(db, user, "dojo", d.id, "create", after=snapshot(d))
    return d


def independent_dojo(db: Session) -> Dojo:
    d = db.scalar(select(Dojo).where(Dojo.is_independent.is_(True)).order_by(Dojo.id))
    if d is None:
        d = Dojo(name="Independiente", short_name="IND", is_independent=True)
        db.add(d)
        db.flush()
    return d


def find_dojo_by_name(db: Session, name: str) -> Dojo | None:
    target = normalize_name(name)
    for d in db.scalars(select(Dojo)).all():
        if normalize_name(d.name) == target or (d.short_name and normalize_name(d.short_name) == target):
            return d
    return None


# ---------------------------------------------------------------------------
# Personas
# ---------------------------------------------------------------------------


def get_person(db: Session, person_id: int) -> Person:
    p = db.get(Person, person_id)
    if p is None:
        raise NotFound("Persona no encontrada")
    return p


def current_membership(db: Session, person_id: int, at: date | None = None) -> DojoMembership | None:
    at = at or date.today()
    rows = db.scalars(
        select(DojoMembership)
        .where(DojoMembership.person_id == person_id, DojoMembership.start_date <= at)
        .order_by(DojoMembership.start_date.desc(), DojoMembership.id.desc())
    ).all()
    for m in rows:
        if m.end_date is None or m.end_date >= at:
            return m
    return None


def current_grade(db: Session, person_id: int, at: date | None = None) -> GradeRecord | None:
    at = at or date.today()
    return db.scalar(
        select(GradeRecord)
        .where(GradeRecord.person_id == person_id, GradeRecord.awarded_on <= at)
        .order_by(GradeRecord.awarded_on.desc(), GradeRecord.id.desc())
    )


def person_out(db: Session, p: Person) -> s.PersonOut:
    out = s.PersonOut.model_validate(p)
    m = current_membership(db, p.id)
    g = current_grade(db, p.id)
    out.current_dojo_id = m.dojo_id if m else None
    out.current_grade = g.grade if g else None
    return out


def _key(p: Person) -> PersonKey:
    doc = p.documents[0] if p.documents else None
    return PersonKey(
        str(p.id),
        p.first_names,
        p.last_names,
        p.birth_date,
        doc.doc_type if doc else None,
        doc.number if doc else None,
    )


def detect_duplicates(
    db: Session,
    first_names: str,
    last_names: str,
    birth_date: date | None,
    doc_type: str | None,
    doc_number: str | None,
    exclude_id: int | None = None,
) -> list[s.DuplicateOut]:
    norm = normalize_name(f"{first_names} {last_names}")
    conds = [Person.normalized_name == norm]
    if birth_date:
        conds.append(Person.birth_date == birth_date)
    q = select(Person).where(Person.merged_into_id.is_(None), or_(*conds))
    candidates = list(db.scalars(q).all())
    if doc_number:
        by_doc = db.scalars(
            select(Person)
            .join(IdentityDocument)
            .where(IdentityDocument.normalized_number == normalize_document(doc_number))
        ).all()
        candidates += [p for p in by_doc if p not in candidates]
    cand = PersonKey("__new__", first_names, last_names, birth_date, doc_type, doc_number)
    people = {str(p.id): p for p in candidates if p.id != exclude_id}
    found = find_duplicates(cand, [_key(p) for p in people.values()])
    return [
        s.DuplicateOut(
            person_id=int(d.person_id),
            reason=d.reason,
            score=d.score,
            full_name=f"{people[d.person_id].first_names} {people[d.person_id].last_names}",
            birth_date=people[d.person_id].birth_date,
        )
        for d in found
    ]


def create_person(db: Session, user: User | None, data: s.PersonCreate, *, commit: bool = True) -> Person:
    dups = detect_duplicates(
        db,
        data.first_names,
        data.last_names,
        data.birth_date,
        data.document.doc_type if data.document else None,
        data.document.number if data.document else None,
    )
    if any(d.reason == "document" for d in dups):
        # Un documento repetido corrompería la identidad: se bloquea.
        raise InvalidState(
            "Ya existe una persona con ese documento",
            code="DUPLICATE_DOCUMENT",
            details={"duplicates": [d.model_dump(mode="json") for d in dups]},
        )
    if dups and not data.override:
        err = WarningsRequireOverride(
            [
                {"code": "POSSIBLE_DUPLICATE", "message": f"Posible duplicado de {d.full_name} ({d.reason})"}
                for d in dups
            ],
            "Posibles personas duplicadas",
        )
        err.details["duplicates"] = [d.model_dump(mode="json") for d in dups]
        raise err

    p = Person(
        first_names=data.first_names.strip(),
        last_names=data.last_names.strip(),
        normalized_name=normalize_name(f"{data.first_names} {data.last_names}"),
        birth_date=data.birth_date,
        sex=data.sex,
        identity_incomplete=data.document is None,
        updated_by_id=user.id if user else None,
    )
    db.add(p)
    db.flush()
    if data.document:
        db.add(
            IdentityDocument(
                person_id=p.id,
                doc_type=data.document.doc_type,
                number=data.document.number.strip(),
                normalized_number=normalize_document(data.document.number),
            )
        )
    if data.dojo_id:
        get_dojo(db, data.dojo_id)
        db.add(
            DojoMembership(person_id=p.id, dojo_id=data.dojo_id, branch_id=data.branch_id, start_date=date(1900, 1, 1))
        )
    if data.grade:
        db.add(
            GradeRecord(
                person_id=p.id,
                grade=data.grade,
                grade_ordinal=grade_to_ordinal(data.grade),
                awarded_on=date(1900, 1, 1),
            )
        )
    if data.consent:
        db.add(DataConsent(person_id=p.id, **data.consent.model_dump()))
    if data.override and dups:
        audit(db, user, "person", p.id, "create_despite_duplicates", reason=data.override.reason)
    audit(db, user, "person", p.id, "create", after=snapshot(p))
    if commit:
        db.commit()
        db.refresh(p)
    return p


def update_person(db: Session, user: User, person_id: int, data: s.PersonUpdate) -> Person:
    p = get_person(db, person_id)
    check_version(p, data.version, "La persona")
    before = snapshot(p)
    for f in ("first_names", "last_names", "birth_date", "sex"):
        v = getattr(data, f)
        if v is not None:
            setattr(p, f, v.strip() if isinstance(v, str) else v)
    p.normalized_name = normalize_name(f"{p.first_names} {p.last_names}")
    if data.document:
        norm = normalize_document(data.document.number)
        clash = db.scalar(
            select(IdentityDocument).where(
                IdentityDocument.doc_type == data.document.doc_type,
                IdentityDocument.normalized_number == norm,
                IdentityDocument.person_id != p.id,
            )
        )
        if clash:
            raise InvalidState("Ese documento pertenece a otra persona", code="DUPLICATE_DOCUMENT")
        for d in list(p.documents):
            if d.doc_type == data.document.doc_type:
                db.delete(d)
        db.flush()
        db.add(
            IdentityDocument(
                person_id=p.id, doc_type=data.document.doc_type, number=data.document.number, normalized_number=norm
            )
        )
        p.identity_incomplete = False
    bump(p, user)
    audit(db, user, "person", p.id, "update", before, snapshot(p))
    db.commit()
    db.refresh(p)
    return p


def add_grade(db: Session, user: User, person_id: int, data: s.GradeIn) -> GradeRecord:
    get_person(db, person_id)
    g = GradeRecord(
        person_id=person_id, grade=data.grade, grade_ordinal=grade_to_ordinal(data.grade), awarded_on=data.awarded_on
    )
    db.add(g)
    audit(db, user, "person", person_id, "add_grade", after={"grade": data.grade, "on": data.awarded_on.isoformat()})
    db.commit()
    return g


def change_dojo(db: Session, user: User, person_id: int, data: s.MembershipIn) -> DojoMembership:
    get_person(db, person_id)
    get_dojo(db, data.dojo_id)
    cur = current_membership(db, person_id, data.start_date)
    if cur:
        cur.end_date = data.start_date
    m = DojoMembership(person_id=person_id, dojo_id=data.dojo_id, branch_id=data.branch_id, start_date=data.start_date)
    db.add(m)
    audit(
        db,
        user,
        "person",
        person_id,
        "change_dojo",
        before={"dojo_id": cur.dojo_id if cur else None},
        after={"dojo_id": data.dojo_id},
    )
    db.commit()
    return m


_MOVABLE = [
    (Registration, Registration.person_id),
    (DojoMembership, DojoMembership.person_id),
    (GradeRecord, GradeRecord.person_id),
    (IdentityDocument, IdentityDocument.person_id),
    (DataConsent, DataConsent.person_id),
    (PersonRole, PersonRole.person_id),
    (User, User.person_id),
    (JudgeVote, JudgeVote.judge_person_id),
]


def merge_persons(db: Session, user: User, data: s.PersonMergeIn) -> PersonMerge:
    if data.keep_id == data.merge_id:
        raise InvalidState("No se puede fusionar una persona consigo misma")
    keep, gone = get_person(db, data.keep_id), get_person(db, data.merge_id)
    if keep.merged_into_id or gone.merged_into_id:
        raise InvalidState("Una de las personas ya fue fusionada")
    moved: dict[str, list[int]] = {}
    for model, col in _MOVABLE:
        ids = list(db.scalars(select(model.id).where(col == gone.id)).all())
        if ids:
            db.execute(update(model).where(model.id.in_(ids)).values({col.key: keep.id}))
            moved[model.__tablename__] = ids
    gone.merged_into_id = keep.id
    bump(gone, user)
    if keep.identity_incomplete and moved.get("identity_documents"):
        keep.identity_incomplete = False
    pm = PersonMerge(
        kept_person_id=keep.id, merged_person_id=gone.id, moved=moved, reason=data.reason, merged_by_id=user.id
    )
    db.add(pm)
    audit(db, user, "person", gone.id, "merge", after={"into": keep.id, "moved": moved}, reason=data.reason)
    db.commit()
    return pm


def revert_merge(db: Session, user: User, merge_id: int) -> PersonMerge:
    pm = db.get(PersonMerge, merge_id)
    if pm is None:
        raise NotFound("Fusión no encontrada")
    if pm.reverted_at:
        raise InvalidState("La fusión ya fue revertida")
    tables = {model.__tablename__: (model, col) for model, col in _MOVABLE}
    for tname, ids in pm.moved.items():
        model, col = tables[tname]
        db.execute(update(model).where(model.id.in_(ids)).values({col.key: pm.merged_person_id}))
    gone = get_person(db, pm.merged_person_id)
    gone.merged_into_id = None
    bump(gone, user)
    pm.reverted_at = utcnow()
    audit(db, user, "person", gone.id, "revert_merge", after={"merge_id": pm.id})
    db.commit()
    return pm
